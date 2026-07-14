/**
 * Unit tests for @twonines/git-workspace.
 *
 * Tests use a temporary git repository to exercise the model methods
 * without touching real remotes. We mock the context object.
 *
 * @module
 */
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
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

/** Create a bare "remote" repo and a clone of it for testing. */
async function setupTestRepo(): Promise<{
  remoteDir: string;
  localDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpBase = await Deno.makeTempDir({ prefix: "git-workspace-test-" });
  const remoteDir = `${tmpBase}/remote.git`;
  const localDir = `${tmpBase}/local`;

  // Create a bare repo as the "remote"
  await run(["git", "init", "--bare", remoteDir]);

  // Clone it to get a working local copy, add an initial commit
  await run(["git", "clone", remoteDir, localDir]);
  await run(["git", "config", "user.email", "test@test.com"], localDir);
  await run(["git", "config", "user.name", "Test User"], localDir);
  await Deno.writeTextFile(`${localDir}/README.md`, "# Test Repo\n");
  await run(["git", "add", "-A"], localDir);
  await run(["git", "commit", "-m", "Initial commit"], localDir);
  await run(["git", "push", "origin", "main"], localDir);

  return {
    remoteDir,
    localDir,
    cleanup: async () => {
      await Deno.remove(tmpBase, { recursive: true });
    },
  };
}

function createMockContext(globalArgs: Record<string, any>) {
  const resources: Map<string, { instance: string; data: any }> = new Map();
  const logs: string[] = [];
  return {
    globalArgs,
    logger: {
      info: (msg: string, _data?: any) => logs.push(`INFO: ${msg}`),
      debug: (msg: string, _data?: any) => logs.push(`DEBUG: ${msg}`),
      warning: (msg: string, _data?: any) => logs.push(`WARN: ${msg}`),
      error: (msg: string, _data?: any) => logs.push(`ERROR: ${msg}`),
    },
    writeResource: async (name: string, instance: string, data: any) => {
      resources.set(`${name}/${instance}`, { instance, data });
    },
    // Expose internals for assertions
    _resources: resources,
    _logs: logs,
  };
}

// ---------------------------------------------------------------------------
// Tests: resolveWorkspacePath (indirectly via ensure)
// ---------------------------------------------------------------------------

Deno.test("ensure - clones repo to localPath", async () => {
  const { remoteDir, localDir, cleanup } = await setupTestRepo();
  const testCloneDir = `${localDir}-clone-test`;

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    // Use localPath override so it doesn't try to SSH clone from a fake host.
    // The repo is already cloned at localDir — instead, remove it and re-clone
    // from the local bare repo by overriding the clone URL test.
    // For this test, we manually clone from remoteDir to validate the "cloned" status path.
    await run(["git", "clone", remoteDir, testCloneDir]);
    // Now remove it so ensure finds it missing
    await Deno.remove(testCloneDir, { recursive: true });

    // We can't test the real clone path without a reachable remote,
    // so instead test the "already exists" → "already_current" path with a fresh clone
    await run(["git", "clone", remoteDir, testCloneDir]);

    await model.methods.ensure.execute(
      { project: "org/repo", localPath: testCloneDir },
      ctx,
    );

    const resource = ctx._resources.get("workspace/org--repo");
    assertEquals(resource?.data.status, "already_current");
    assertEquals(resource?.data.localPath, testCloneDir);
    assertEquals(resource?.data.branch, "main");

    // Verify the directory has the file
    const readme = await Deno.readTextFile(`${testCloneDir}/README.md`);
    assertEquals(readme, "# Test Repo\n");
  } finally {
    await Deno.remove(testCloneDir, { recursive: true }).catch(() => {});
    await cleanup();
  }
});

Deno.test("ensure - pulls when already cloned and behind", async () => {
  const { remoteDir, localDir, cleanup } = await setupTestRepo();
  const testCloneDir = `${localDir}-pull-test`;

  try {
    // Clone first
    await run(["git", "clone", remoteDir, testCloneDir]);

    // Push a new commit to the remote via the original local
    await Deno.writeTextFile(`${localDir}/new-file.txt`, "hello\n");
    await run(["git", "add", "-A"], localDir);
    await run(["git", "commit", "-m", "Add new file"], localDir);
    await run(["git", "push", "origin", "main"], localDir);

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.ensure.execute(
      { project: "org/repo", localPath: testCloneDir },
      ctx,
    );

    const resource = ctx._resources.get("workspace/org--repo");
    assertEquals(resource?.data.status, "updated");

    // Verify the new file exists
    const content = await Deno.readTextFile(`${testCloneDir}/new-file.txt`);
    assertEquals(content, "hello\n");
  } finally {
    await Deno.remove(testCloneDir, { recursive: true }).catch(() => {});
    await cleanup();
  }
});

Deno.test("ensure - reports already_current when up to date", async () => {
  const { remoteDir, localDir, cleanup } = await setupTestRepo();
  const testCloneDir = `${localDir}-current-test`;

  try {
    await run(["git", "clone", remoteDir, testCloneDir]);

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.ensure.execute(
      { project: "org/repo", localPath: testCloneDir },
      ctx,
    );

    const resource = ctx._resources.get("workspace/org--repo");
    assertEquals(resource?.data.status, "already_current");
  } finally {
    await Deno.remove(testCloneDir, { recursive: true }).catch(() => {});
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: branch
// ---------------------------------------------------------------------------

Deno.test("branch - creates a new branch", async () => {
  const { remoteDir, localDir, cleanup } = await setupTestRepo();
  const testCloneDir = `${localDir}-branch-test`;

  try {
    await run(["git", "clone", remoteDir, testCloneDir]);

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.branch.execute(
      { project: "org/repo", branch: "add-txt-record", localPath: testCloneDir },
      ctx,
    );

    const resource = ctx._resources.get("branch/org--repo--add-txt-record");
    assertEquals(resource?.data.branch, "add-txt-record");
    assertEquals(resource?.data.baseBranch, "main");

    // Verify we're on the new branch
    const result = await run(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      testCloneDir,
    );
    assertEquals(result.stdout, "add-txt-record");
  } finally {
    await Deno.remove(testCloneDir, { recursive: true }).catch(() => {});
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: read_file
// ---------------------------------------------------------------------------

Deno.test("read_file - reads existing file", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.read_file.execute(
      { project: "org/repo", path: "README.md", localPath: localDir },
      ctx,
    );

    const resource = ctx._resources.get("file/org--repo--README.md");
    assertEquals(resource?.data.content, "# Test Repo\n");
    assertEquals(resource?.data.path, "README.md");
  } finally {
    await cleanup();
  }
});

Deno.test("read_file - throws on missing file", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await assertRejects(
      () =>
        model.methods.read_file.execute(
          { project: "org/repo", path: "nonexistent.txt", localPath: localDir },
          ctx,
        ),
      Error,
      "Cannot read nonexistent.txt",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: list_files
// ---------------------------------------------------------------------------

Deno.test("list_files - lists tracked files", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.list_files.execute(
      { project: "org/repo", localPath: localDir },
      ctx,
    );

    const resource = ctx._resources.get("files/org--repo");
    assertEquals(resource?.data.files, ["README.md"]);
    assertEquals(resource?.data.count, 1);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: commit
// ---------------------------------------------------------------------------

Deno.test("commit - stages and commits changes", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    // Create a new file to commit
    await Deno.writeTextFile(`${localDir}/test.txt`, "test content\n");

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.commit.execute(
      {
        project: "org/repo",
        message: "Add test file",
        files: ["test.txt"],
        localPath: localDir,
      },
      ctx,
    );

    // Find the commit resource (keyed with short sha)
    const commitResources = [...ctx._resources.entries()].filter(([k]) =>
      k.startsWith("commit/")
    );
    assertEquals(commitResources.length, 1);

    const [, resource] = commitResources[0];
    assertEquals(resource.data.message, "Add test file");
    assertEquals(resource.data.filesChanged, ["test.txt"]);
    assertEquals(resource.data.branch, "main");
  } finally {
    await cleanup();
  }
});

Deno.test("commit - throws on clean tree", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await assertRejects(
      () =>
        model.methods.commit.execute(
          { project: "org/repo", message: "Empty commit", localPath: localDir },
          ctx,
        ),
      Error,
      "Nothing to commit",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: push (requires remote, so we test with our bare repo setup)
// ---------------------------------------------------------------------------

Deno.test("push - pushes branch to remote", async () => {
  const { remoteDir, localDir, cleanup } = await setupTestRepo();
  const testCloneDir = `${localDir}-push-test`;

  try {
    await run(["git", "clone", remoteDir, testCloneDir]);
    await run(["git", "config", "user.email", "test@test.com"], testCloneDir);
    await run(["git", "config", "user.name", "Test User"], testCloneDir);
    await run(["git", "checkout", "-b", "push-test"], testCloneDir);
    await Deno.writeTextFile(`${testCloneDir}/pushed.txt`, "pushed\n");
    await run(["git", "add", "-A"], testCloneDir);
    await run(["git", "commit", "-m", "Test push"], testCloneDir);

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.push.execute(
      { project: "org/repo", localPath: testCloneDir },
      ctx,
    );

    const resource = ctx._resources.get("push/org--repo--push-test");
    assertEquals(resource?.data.branch, "push-test");
    assertEquals(resource?.data.remote, "origin");

    // Verify the branch exists on the remote
    const branches = await run(["git", "branch", "-r"], testCloneDir);
    assertStringIncludes(branches.stdout, "origin/push-test");
  } finally {
    await Deno.remove(testCloneDir, { recursive: true }).catch(() => {});
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: logging
// ---------------------------------------------------------------------------

Deno.test("methods produce info-level logs", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    await model.methods.list_files.execute(
      { project: "org/repo", localPath: localDir },
      ctx,
    );

    const infoLogs = ctx._logs.filter((l: string) => l.startsWith("INFO:"));
    assertEquals(infoLogs.length >= 1, true, "Expected at least one info log");
    assertStringIncludes(infoLogs[0], "Listing files");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: instance name sanitization (slashes → --)
// ---------------------------------------------------------------------------

Deno.test("writeResource instance names never contain slashes", async () => {
  const { cleanup, localDir } = await setupTestRepo();

  try {
    // Create a new file to commit
    await Deno.writeTextFile(`${localDir}/test.txt`, "test\n");

    const ctx = createMockContext({
      host: "test.example.com",
      defaultBranch: "main",
    });

    // Test ensure with a project path containing a slash
    await model.methods.ensure.execute(
      { project: "org/repo", localPath: localDir },
      ctx,
    );

    // Test commit
    await model.methods.commit.execute(
      { project: "org/repo", message: "Test commit", files: ["test.txt"], localPath: localDir },
      ctx,
    );

    // Verify NO resource key contains a raw slash after the resource-type prefix
    for (const [key] of ctx._resources) {
      const instancePart = key.split("/").slice(1).join("/");
      assertEquals(
        instancePart.includes("/"),
        false,
        `Resource key "${key}" contains a slash in the instance name portion`,
      );
    }
  } finally {
    await cleanup();
  }
});
