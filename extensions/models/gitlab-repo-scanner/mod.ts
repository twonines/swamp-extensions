/**
 * Scans a GitLab repository and returns structured metadata, a recursive
 * file tree, and the contents of high-signal files. Use `fetch_files`
 * for on-demand content retrieval of paths discovered in the file tree.
 * Use `discover` to find active repos across configured groups.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

// Swamp method execution context. The SDK does not export a public type for
// this yet, so we alias `any` with a single scoped ignore. All downstream
// signatures reference `Ctx` — if the SDK ever ships a concrete type, this
// alias becomes the single point of change.
// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_HIGH_SIGNAL_FILES = [
  ".gitlab-ci.yml",
  "go.mod",
  "Cargo.toml",
  "package.json",
  "pom.xml",
  "requirements.txt",
  "pyproject.toml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  "README.md",
];

const GlobalArgsSchema = z.object({
  url: z.string().url().describe(
    "GitLab instance base URL (e.g. https://gitlab.com)",
  ),
  token: z.string().meta({ sensitive: true }).describe(
    "Personal access token with read_api scope. Vault this — never inline.",
  ),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const ContributorSchema = z.object({
  name: z.string(),
  email: z.string(),
  commits: z.number(),
});

const FileEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["blob", "tree"]),
});

const KnownFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

const RepoScanSchema = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  lastActivityAt: z.string(),
  visibility: z.string(),
  languages: z.record(z.string(), z.number()),
  starCount: z.number(),
  forksCount: z.number(),
  topics: z.array(z.string()),
  contributors: z.array(ContributorSchema),
  fileTree: z.array(FileEntrySchema),
  knownFiles: z.array(KnownFileSchema),
  scannedAt: z.string(),
});

const FetchedFileSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  error: z.string().optional(),
  truncated: z.boolean(),
});

const FetchFilesResultSchema = z.object({
  path: z.string(),
  files: z.array(FetchedFileSchema),
  fetchedAt: z.string(),
});

const DiscoveredRepoSchema = z.object({
  path: z.string(),
  lastActivityAt: z.string(),
  visibility: z.string(),
});

const DiscoverResultSchema = z.object({
  repos: z.array(DiscoveredRepoSchema),
  totalFound: z.number(),
  filters: z.object({
    groups: z.array(z.string()).optional(),
    activeSince: z.string().optional(),
    archived: z.boolean(),
  }),
  discoveredAt: z.string(),
});

const MAX_FILE_BYTES = 32_768; // 32KB
const MAX_README_BYTES = 2_048; // 2KB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

async function gitlabGet(
  base: string,
  token: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${base}/api/v4/${path}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`GitLab API error ${res.status} for ${path}`);
  }
  return res.json();
}

async function fetchFileRaw(
  base: string,
  token: string,
  projectId: string,
  filePath: string,
  branch: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean } | null> {
  try {
    const encoded = encodeURIComponent(filePath);
    const res = await fetch(
      `${base}/api/v4/projects/${projectId}/repository/files/${encoded}/raw?ref=${
        encodeURIComponent(branch)
      }`,
      { headers: authHeaders(token) },
    );
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > maxBytes) {
      return { content: text.slice(0, maxBytes), truncated: true };
    }
    return { content: text, truncated: false };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Model definition for `@twonines/gitlab-repo-scanner`. Exposes three
 * methods over GitLab's REST API: `discover` (find active repos across
 * configured groups), `scan` (fetch metadata + recursive file tree +
 * contents of high-signal files for a single repo), and `fetch_files`
 * (on-demand content retrieval for paths discovered in the tree).
 * Requires a GitLab personal access token with `read_api` scope,
 * typically sourced from a swamp vault via `vault.get(...)`.
 */
export const model = {
  type: "@twonines/gitlab-repo-scanner",
  version: "2026.07.03.1",
  description:
    "Scans a GitLab repository: returns structured metadata, a recursive file tree, " +
    "and contents of high-signal files. Use fetch_files for on-demand content " +
    "retrieval of paths discovered in the file tree.",
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description: "Repository scan result",
      schema: RepoScanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    files: {
      description: "On-demand file content result",
      schema: FetchFilesResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    discovery: {
      description: "List of discovered repos matching filters",
      schema: DiscoverResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description:
        "Scan a repository. Returns metadata, recursive file tree (paths only), " +
        "and contents of known high-signal files (.gitlab-ci.yml, go.mod, Dockerfile, etc.).",
      arguments: z.object({
        projectPath: z
          .string()
          .describe("Repository path (e.g. myorg/myrepo)"),
        highSignalFiles: z
          .array(z.string())
          .optional()
          .describe("Override the default list of files to auto-fetch on scan"),
      }),
      execute: async (
        args: { projectPath: string; highSignalFiles?: string[] },
        context: Ctx,
      ) => {
        const { url, token } = context.globalArgs as z.infer<
          typeof GlobalArgsSchema
        >;
        const projectPath = args.projectPath;
        const signalFiles = args.highSignalFiles ?? DEFAULT_HIGH_SIGNAL_FILES;
        const id = encodeURIComponent(projectPath);

        context.logger.info("Scanning repository {path}", {
          path: projectPath,
        });

        const project = await gitlabGet(url, token, `projects/${id}`) as Record<
          string,
          unknown
        >;
        const defaultBranch = String(project.default_branch ?? "main");
        const ref = encodeURIComponent(defaultBranch);

        const languages = await gitlabGet(
          url,
          token,
          `projects/${id}/languages`,
        ) as Record<string, number>;

        const contributorsRaw = await gitlabGet(
          url,
          token,
          `projects/${id}/repository/contributors?order_by=commits&sort=desc&per_page=20`,
        ) as Array<Record<string, unknown>>;

        const treeRaw = await gitlabGet(
          url,
          token,
          `projects/${id}/repository/tree?recursive=true&per_page=500&ref=${ref}`,
        ) as Array<Record<string, unknown>>;

        const treePaths = new Set(treeRaw.map((f) => String(f.path ?? "")));
        const knownFiles: z.infer<typeof KnownFileSchema>[] = [];

        for (const candidate of signalFiles) {
          if (!treePaths.has(candidate)) continue;
          const maxBytes = candidate === "README.md"
            ? MAX_README_BYTES
            : MAX_FILE_BYTES;
          const result = await fetchFileRaw(
            url,
            token,
            id,
            candidate,
            defaultBranch,
            maxBytes,
          );
          if (result !== null) {
            knownFiles.push({ path: candidate, ...result });
          }
        }

        const data: z.infer<typeof RepoScanSchema> = {
          path: projectPath,
          name: String(project.name ?? ""),
          description: (project.description as string | null) ?? null,
          defaultBranch,
          lastActivityAt: String(project.last_activity_at ?? ""),
          visibility: String(project.visibility ?? ""),
          languages,
          starCount: Number(project.star_count ?? 0),
          forksCount: Number(project.forks_count ?? 0),
          topics: (project.topics as string[] | undefined) ?? [],
          contributors: contributorsRaw.map((c) => ({
            name: String(c.name ?? ""),
            email: String(c.email ?? ""),
            commits: Number(c.commits ?? 0),
          })),
          fileTree: treeRaw.map((f) => ({
            path: String(f.path ?? ""),
            type: (f.type === "tree" ? "tree" : "blob") as "blob" | "tree",
          })),
          knownFiles,
          scannedAt: new Date().toISOString(),
        };

        context.logger.info(
          "Scan complete: {files} tree entries, {known} known files",
          { files: data.fileTree.length, known: data.knownFiles.length },
        );

        const handle = await context.writeResource(
          "scan",
          projectPath.replaceAll("/", "--"),
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    fetch_files: {
      description:
        "Fetch raw content of specific files by path. Use after scan to retrieve " +
        "content of files spotted in the file tree that are not in the high-signal list.",
      arguments: z.object({
        projectPath: z.string().describe("Repository path (e.g. myorg/myrepo)"),
        branch: z
          .string()
          .optional()
          .describe("Branch to read from (defaults to default branch)"),
        paths: z
          .array(z.string())
          .describe("File paths relative to repo root"),
      }),
      execute: async (
        args: { projectPath: string; branch?: string; paths: string[] },
        context: Ctx,
      ) => {
        const { url, token } = context.globalArgs as z.infer<
          typeof GlobalArgsSchema
        >;
        const id = encodeURIComponent(args.projectPath);

        let branch = args.branch;
        if (!branch) {
          const project = await gitlabGet(
            url,
            token,
            `projects/${id}`,
          ) as Record<string, unknown>;
          branch = String(project.default_branch ?? "main");
        }

        context.logger.info(
          "Fetching {count} files from {path}",
          { count: args.paths.length, path: args.projectPath },
        );

        const files: z.infer<typeof FetchedFileSchema>[] = [];
        for (const path of args.paths) {
          const result = await fetchFileRaw(
            url,
            token,
            id,
            path,
            branch,
            MAX_FILE_BYTES,
          );
          if (result === null) {
            files.push({
              path,
              content: null,
              error: "not found or not readable",
              truncated: false,
            });
          } else {
            files.push({
              path,
              content: result.content,
              truncated: result.truncated,
            });
          }
        }

        const data: z.infer<typeof FetchFilesResultSchema> = {
          path: args.projectPath,
          files,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "files",
          args.projectPath.replaceAll("/", "--"),
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    discover: {
      description:
        "Discover active repositories from the GitLab instance. Returns paths " +
        "suitable as input to the scan method or a batch scan workflow.",
      arguments: z.object({
        groups: z
          .array(z.string())
          .optional()
          .describe(
            "Limit to these group paths (e.g. ['engineering', 'platform'])",
          ),
        activeSince: z
          .string()
          .optional()
          .describe(
            "ISO date — only repos with activity after this date (default: 90 days ago)",
          ),
        perPage: z
          .number()
          .optional()
          .describe("Results per page (default: 100, max: 100)"),
        maxPages: z
          .number()
          .optional()
          .describe("Max pages to fetch (default: 10)"),
      }),
      execute: async (
        args: {
          groups?: string[];
          activeSince?: string;
          perPage?: number;
          maxPages?: number;
        },
        context: Ctx,
      ) => {
        const { url, token } = context.globalArgs as z.infer<
          typeof GlobalArgsSchema
        >;
        const perPage = Math.min(args.perPage ?? 100, 100);
        const maxPages = args.maxPages ?? 10;

        const since = args.activeSince ??
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split(
            "T",
          )[0];

        context.logger.info("Discovering repos active since {since}", {
          since,
        });

        const repos: z.infer<typeof DiscoveredRepoSchema>[] = [];

        if (args.groups && args.groups.length > 0) {
          for (const group of args.groups) {
            const groupId = encodeURIComponent(group);
            for (let page = 1; page <= maxPages; page++) {
              const projects = await gitlabGet(
                url,
                token,
                `groups/${groupId}/projects?include_subgroups=true&archived=false` +
                  `&last_activity_after=${since}&per_page=${perPage}&page=${page}` +
                  `&order_by=last_activity_at&sort=desc`,
              ) as Array<Record<string, unknown>>;
              for (const p of projects) {
                repos.push({
                  path: String(p.path_with_namespace ?? ""),
                  lastActivityAt: String(p.last_activity_at ?? ""),
                  visibility: String(p.visibility ?? ""),
                });
              }
              if (projects.length < perPage) break;
            }
          }
        } else {
          for (let page = 1; page <= maxPages; page++) {
            const projects = await gitlabGet(
              url,
              token,
              `projects?archived=false&last_activity_after=${since}` +
                `&per_page=${perPage}&page=${page}&order_by=last_activity_at&sort=desc`,
            ) as Array<Record<string, unknown>>;
            for (const p of projects) {
              repos.push({
                path: String(p.path_with_namespace ?? ""),
                lastActivityAt: String(p.last_activity_at ?? ""),
                visibility: String(p.visibility ?? ""),
              });
            }
            if (projects.length < perPage) break;
          }
        }

        context.logger.info("Discovered {count} repos", {
          count: repos.length,
        });

        const data: z.infer<typeof DiscoverResultSchema> = {
          repos,
          totalFound: repos.length,
          filters: {
            groups: args.groups,
            activeSince: since,
            archived: false,
          },
          discoveredAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("discovery", "latest", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
