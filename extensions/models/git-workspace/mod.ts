/**
 * Local git operations model — clone, branch, read, commit, push.
 *
 * Designed for agent-driven development workflows where code changes are
 * authored locally and pushed to a remote forge. Pairs with @webframp/gitlab
 * (or any forge model) for MR/PR creation after push.
 *
 * Workspace layout default: $HOME/{host}/{group}/{project}
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { z } from "npm:zod@4";

type Ctx = any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    env: opts.env ? { ...Deno.env.toObject(), ...opts.env } : undefined,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(["git", ...args], { cwd });
}

/**
 * Resolve the local path for a given project.
 * Pattern: baseDir/{host}/{group}/{project}
 */
function resolveWorkspacePath(
  globalArgs: { baseDir?: string; host: string },
  projectPath: string,
  explicitPath?: string,
): string {
  if (explicitPath) return explicitPath;
  const base = globalArgs.baseDir || Deno.env.get("HOME") || "/tmp";
  const host = globalArgs.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `${base}/${host}/${projectPath}`;
}

function cloneUrl(
  host: string,
  projectPath: string,
  protocol: "ssh" | "https" = "ssh",
): string {
  const h = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (protocol === "https") {
    return `https://${h}/${projectPath}.git`;
  }
  return `git@${h}:${projectPath}.git`;
}

/**
 * Detect the default branch for a repo by querying the remote HEAD.
 * Falls back to the configured default if detection fails.
 */
async function detectDefaultBranch(
  localPath: string,
  fallback: string,
): Promise<string> {
  // Try symbolic-ref on origin/HEAD (works if repo is cloned)
  const symRef = await git(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    localPath,
  );
  if (symRef.code === 0 && symRef.stdout) {
    // Returns "origin/main" or "origin/master" — strip the "origin/" prefix
    return symRef.stdout.replace(/^origin\//, "");
  }

  // If symbolic-ref fails (e.g. fresh clone without HEAD set), try remote show
  const show = await git(["remote", "show", "origin"], localPath);
  if (show.code === 0) {
    const match = show.stdout.match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z.string().describe(
    "Git remote host (e.g. gitlab.example.com, codeberg.org). Used to construct clone URLs and workspace paths.",
  ),
  baseDir: z.string().optional().describe(
    "Base directory for workspaces. Default: $HOME. Repos are placed at {baseDir}/{host}/{group}/{project}.",
  ),
  defaultBranch: z.string().optional().describe(
    "Default branch name (default: main). Used as the base for new branches.",
  ),
  commitFormat: z.string().optional().describe(
    "Commit message format hint for the agent. Example: 'leading-verb, 50 char title, blank line, body explains why'.",
  ),
  protocol: z.enum(["ssh", "https"]).optional().describe(
    "Clone protocol. 'ssh' (default) uses git@host:project.git; 'https' uses https://host/project.git.",
  ),
});

const EnsureOutputSchema = z.object({
  localPath: z.string(),
  project: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  status: z.enum(["cloned", "updated", "already_current"]),
  updatedAt: z.string(),
});

const BranchOutputSchema = z.object({
  localPath: z.string(),
  project: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  createdAt: z.string(),
});

const ReadFileOutputSchema = z.object({
  project: z.string(),
  path: z.string(),
  content: z.string(),
  sizeBytes: z.number(),
  readAt: z.string(),
});

const ListFilesOutputSchema = z.object({
  project: z.string(),
  pattern: z.string(),
  files: z.array(z.string()),
  count: z.number(),
  listedAt: z.string(),
});

const CommitOutputSchema = z.object({
  project: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  message: z.string(),
  filesChanged: z.array(z.string()),
  committedAt: z.string(),
});

const PushOutputSchema = z.object({
  project: z.string(),
  branch: z.string(),
  remote: z.string(),
  commitSha: z.string(),
  pushedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Git workspace model — local clone, branch, read, commit, push operations. */
export const model = {
  type: "@twonines/git-workspace",
  version: "2026.07.15.1",
  description: "Local git operations — clone, branch, read, commit, push. " +
    "Workspace layout: $HOME/{host}/{group}/{project} by default. " +
    "Designed for agent-driven development workflows.",
  globalArguments: GlobalArgsSchema,
  resources: {
    workspace: {
      description: "State of a cloned/updated workspace",
      schema: EnsureOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    branch: {
      description: "Created branch metadata",
      schema: BranchOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    file: {
      description: "Contents of a file read from the workspace",
      schema: ReadFileOutputSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    files: {
      description: "File listing from the workspace",
      schema: ListFilesOutputSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    commit: {
      description: "Result of a git commit",
      schema: CommitOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    push: {
      description: "Result of a git push",
      schema: PushOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Clone the repo if it doesn't exist locally, or fetch + pull if it does. " +
        "Leaves the workspace on the default branch at latest remote HEAD.",
      arguments: z.object({
        project: z.string().describe(
          "Project path (e.g. myorg/my-repo, team/infra-dns).",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local path.",
        ),
        protocol: z.enum(["ssh", "https"]).optional().describe(
          "Override the global clone protocol for this project.",
        ),
      }),
      execute: async (
        args: {
          project: string;
          localPath?: string;
          protocol?: "ssh" | "https";
        },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );
        const proto = args.protocol || ga.protocol || "ssh";
        const url = cloneUrl(ga.host, args.project, proto);

        context.logger.info("Ensuring workspace for {project} at {path}", {
          project: args.project,
          path: localPath,
        });

        let status: "cloned" | "updated" | "already_current";

        const dirCheck = await run(["test", "-d", `${localPath}/.git`]);

        if (dirCheck.code !== 0) {
          const parentDir = localPath.split("/").slice(0, -1).join("/");
          await run(["mkdir", "-p", parentDir]);
          const clone = await git(["clone", url, localPath], "/tmp");
          if (clone.code !== 0) {
            throw new Error(`git clone failed: ${clone.stderr}`);
          }
          status = "cloned";
        } else {
          const fetch = await git(["fetch", "origin"], localPath);
          if (fetch.code !== 0) {
            throw new Error(`git fetch failed: ${fetch.stderr}`);
          }

          // Auto-detect default branch from remote HEAD
          const defaultBranch = await detectDefaultBranch(
            localPath,
            ga.defaultBranch || "main",
          );

          const currentBranch = await git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            localPath,
          );
          if (currentBranch.stdout !== defaultBranch) {
            await git(["checkout", defaultBranch], localPath);
          }

          const localSha = await git(["rev-parse", "HEAD"], localPath);
          const remoteSha = await git(
            ["rev-parse", `origin/${defaultBranch}`],
            localPath,
          );

          if (localSha.stdout === remoteSha.stdout) {
            status = "already_current";
          } else {
            const pull = await git(
              ["pull", "--ff-only", "origin", defaultBranch],
              localPath,
            );
            if (pull.code !== 0) {
              throw new Error(`git pull failed: ${pull.stderr}`);
            }
            status = "updated";
          }
        }

        const sha = await git(["rev-parse", "HEAD"], localPath);
        const branch = await git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          localPath,
        );

        context.logger.info("Workspace {project}: {status} at {sha}", {
          project: args.project,
          status,
          sha: (await git(["rev-parse", "--short", "HEAD"], localPath)).stdout,
        });

        const result = {
          localPath,
          project: args.project,
          branch: branch.stdout,
          commitSha: sha.stdout,
          status,
          updatedAt: new Date().toISOString(),
        };

        await context.writeResource(
          "workspace",
          args.project.replace(/\//g, "--"),
          result,
        );
        return { dataHandles: [] };
      },
    },

    branch: {
      description: "Create a new branch from the latest default branch HEAD.",
      arguments: z.object({
        project: z.string().describe("Project path."),
        branch: z.string().describe(
          "Branch name to create (e.g. feat/add-txt-record).",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local path.",
        ),
      }),
      execute: async (
        args: { project: string; branch: string; localPath?: string },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );

        context.logger.info(
          "Creating branch {branch} from {base} in {project}",
          {
            branch: args.branch,
            base: "auto-detected default",
            project: args.project,
          },
        );

        // Auto-detect default branch
        const defaultBranch = await detectDefaultBranch(
          localPath,
          ga.defaultBranch || "main",
        );

        await git(["checkout", defaultBranch], localPath);
        await git(["pull", "--ff-only", "origin", defaultBranch], localPath);

        const create = await git(["checkout", "-b", args.branch], localPath);
        if (create.code !== 0) {
          const switchBranch = await git(["checkout", args.branch], localPath);
          if (switchBranch.code !== 0) {
            throw new Error(
              `Failed to create/switch branch: ${create.stderr} / ${switchBranch.stderr}`,
            );
          }
        }

        const baseSha = await git(
          ["rev-parse", `origin/${defaultBranch}`],
          localPath,
        );

        const result = {
          localPath,
          project: args.project,
          branch: args.branch,
          baseBranch: defaultBranch,
          baseSha: baseSha.stdout,
          createdAt: new Date().toISOString(),
        };

        await context.writeResource(
          "branch",
          `${args.project}--${args.branch}`.replace(/\//g, "--"),
          result,
        );
        return { dataHandles: [] };
      },
    },

    read_file: {
      description: "Read a file from the workspace. Run ensure first to clone.",
      arguments: z.object({
        project: z.string().describe("Project path."),
        path: z.string().describe(
          "File path relative to repo root.",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local workspace path.",
        ),
      }),
      execute: async (
        args: { project: string; path: string; localPath?: string },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );
        const filePath = `${localPath}/${args.path}`;

        context.logger.info("Reading {path} from {project}", {
          path: args.path,
          project: args.project,
        });

        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch (e: any) {
          throw new Error(
            `Cannot read ${args.path}: ${e.message}. Run ensure first.`,
          );
        }

        const stat = await Deno.stat(filePath);

        const result = {
          project: args.project,
          path: args.path,
          content,
          sizeBytes: stat.size,
          readAt: new Date().toISOString(),
        };

        const instanceName = `${args.project}--${args.path}`.replace(
          /\//g,
          "--",
        );
        await context.writeResource("file", instanceName, result);
        return { dataHandles: [] };
      },
    },

    list_files: {
      description: "List tracked files matching a pattern (via git ls-files).",
      arguments: z.object({
        project: z.string().describe("Project path."),
        pattern: z.string().optional().describe(
          "Glob pattern or directory (e.g. 'terraform/**/*.tf'). Default: all tracked files.",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local workspace path.",
        ),
      }),
      execute: async (
        args: { project: string; pattern?: string; localPath?: string },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );
        const pattern = args.pattern || ".";

        context.logger.info("Listing files in {project} matching {pattern}", {
          project: args.project,
          pattern,
        });

        const lsArgs = ["ls-files"];
        if (pattern !== ".") {
          lsArgs.push(pattern);
        }

        const ls = await git(lsArgs, localPath);
        if (ls.code !== 0) {
          throw new Error(`git ls-files failed: ${ls.stderr}`);
        }

        const files = ls.stdout.split("\n").filter((f) => f.length > 0);

        const result = {
          project: args.project,
          pattern,
          files,
          count: files.length,
          listedAt: new Date().toISOString(),
        };

        await context.writeResource(
          "files",
          args.project.replace(/\//g, "--"),
          result,
        );
        return { dataHandles: [] };
      },
    },

    commit: {
      description:
        "Stage files and commit. Message should follow commitFormat if set. " +
        "Default: leading-verb imperative, ≤50 char title, body explains why.",
      arguments: z.object({
        project: z.string().describe("Project path."),
        message: z.string().describe("Commit message."),
        files: z.array(z.string()).optional().describe(
          "Files to stage (relative to repo root). Omit to stage all changes.",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local workspace path.",
        ),
      }),
      execute: async (
        args: {
          project: string;
          message: string;
          files?: string[];
          localPath?: string;
        },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );

        context.logger.info("Committing to {project}: {message}", {
          project: args.project,
          message: args.message.split("\n")[0],
        });

        if (args.files && args.files.length > 0) {
          const add = await git(["add", ...args.files], localPath);
          if (add.code !== 0) {
            throw new Error(`git add failed: ${add.stderr}`);
          }
        } else {
          const add = await git(["add", "-A"], localPath);
          if (add.code !== 0) {
            throw new Error(`git add -A failed: ${add.stderr}`);
          }
        }

        const status = await git(["status", "--porcelain"], localPath);
        if (!status.stdout) {
          throw new Error("Nothing to commit — working tree clean.");
        }

        const commitResult = await git(
          ["commit", "-m", args.message],
          localPath,
        );
        if (commitResult.code !== 0) {
          throw new Error(`git commit failed: ${commitResult.stderr}`);
        }

        const sha = await git(["rev-parse", "HEAD"], localPath);
        const branch = await git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          localPath,
        );
        const diff = await git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
          localPath,
        );
        const filesChanged = diff.stdout.split("\n").filter((f) =>
          f.length > 0
        );

        const result = {
          project: args.project,
          branch: branch.stdout,
          commitSha: sha.stdout,
          message: args.message,
          filesChanged,
          committedAt: new Date().toISOString(),
        };

        await context.writeResource(
          "commit",
          `${args.project}--${sha.stdout.slice(0, 8)}`.replace(/\//g, "--"),
          result,
        );
        return { dataHandles: [] };
      },
    },

    push: {
      description: "Push the current branch to origin with -u tracking.",
      arguments: z.object({
        project: z.string().describe("Project path."),
        force: z.boolean().optional().describe(
          "Force push (--force-with-lease). Default: false.",
        ),
        localPath: z.string().optional().describe(
          "Override the computed local workspace path.",
        ),
      }),
      execute: async (
        args: { project: string; force?: boolean; localPath?: string },
        context: Ctx,
      ) => {
        const ga = context.globalArgs;
        const localPath = resolveWorkspacePath(
          ga,
          args.project,
          args.localPath,
        );

        const branch = await git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          localPath,
        );
        if (branch.code !== 0) {
          throw new Error(`Cannot determine current branch: ${branch.stderr}`);
        }

        context.logger.info("Pushing {branch} to origin for {project}", {
          branch: branch.stdout,
          project: args.project,
        });

        const pushArgs = ["push", "-u", "origin", branch.stdout];
        if (args.force) {
          pushArgs.splice(1, 0, "--force-with-lease");
        }

        const pushResult = await git(pushArgs, localPath);
        if (pushResult.code !== 0) {
          throw new Error(`git push failed: ${pushResult.stderr}`);
        }

        const sha = await git(["rev-parse", "HEAD"], localPath);

        const result = {
          project: args.project,
          branch: branch.stdout,
          remote: "origin",
          commitSha: sha.stdout,
          pushedAt: new Date().toISOString(),
        };

        await context.writeResource(
          "push",
          `${args.project}--${branch.stdout}`.replace(/\//g, "--"),
          result,
        );
        return { dataHandles: [] };
      },
    },
  },
};
