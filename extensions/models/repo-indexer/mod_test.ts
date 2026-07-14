// ABOUTME: Unit tests for @twonines/repo-indexer's model methods.
// ABOUTME: index/reindex/status/search run against a real local git fixture (real clone,
// ABOUTME: real chunking, real sqlite3-wasm build) with only the embeddings/GitLab API
// ABOUTME: fetch calls stubbed. discover/list-indexed/list-searches use a plain mock context.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "jsr:@std/assert";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

interface StoredResource {
  name: string;
  specName: string;
  data: Record<string, unknown>;
  tags: Record<string, string>;
  content: Uint8Array;
}

function createRepoIndexerTestContext(opts?: {
  globalArgs?: Record<string, unknown>;
  seed?: StoredResource[];
}) {
  const store = new Map<string, StoredResource>();
  for (const s of opts?.seed ?? []) store.set(s.name, s);

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string; specName: string }> => {
    const tags = { specName };
    const content = new TextEncoder().encode(JSON.stringify(data));
    store.set(name, { name, specName, data, tags, content });
    return Promise.resolve({ name, specName });
  };

  const readResource = (
    name: string,
  ): Promise<Record<string, unknown> | null> => {
    const entry = store.get(name);
    return Promise.resolve(entry ? entry.data : null);
  };

  const dataRepository = {
    findAllForModel: (_type: string, _id: string) => {
      const results = [...store.values()].map((r) => ({
        tags: r.tags,
        name: r.name,
      }));
      return Promise.resolve(results);
    },
    getContent: (_type: string, _id: string, name: string) => {
      const entry = store.get(name);
      return Promise.resolve(entry ? entry.content : null);
    },
  };

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const context = {
    writeResource,
    readResource,
    dataRepository,
    logger,
    modelType: "@twonines/repo-indexer",
    modelId: "test-instance-id",
    globalArgs: {
      gitlabUrl: "https://gitlab.example.com",
      gitlabToken: "test-token",
      embedUrl: "http://fake.test",
      embedToken: "test-token",
      embedDim: 8,
      ...opts?.globalArgs,
    },
  };

  return { context, store };
}

// ---------------------------------------------------------------------------
// Real local git fixture -- index/reindex clone via a real `git` subprocess,
// so tests drive that against an actual local repo rather than mocking git.
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): void {
  const result = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

function writeFixtureFiles(repoPath: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = `${repoPath}/${relPath}`;
    const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
    if (dir && dir !== repoPath) Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(fullPath, content);
  }
}

function createFixtureRepo(
  files: Record<string, string>,
  opts?: { name?: string; existingGroupDir?: string },
) {
  const name = opts?.name ?? "myrepo";
  let base: string | undefined;
  let groupDir: string;
  if (opts?.existingGroupDir) {
    groupDir = opts.existingGroupDir;
  } else {
    base = Deno.makeTempDirSync({ prefix: "repo-indexer-fixture-" });
    groupDir = `${base}/group`;
  }
  const repoPath = `${groupDir}/${name}.git`;
  Deno.mkdirSync(repoPath, { recursive: true });
  runGit(["init", "-q"], repoPath);
  runGit(["config", "user.email", "test@test.com"], repoPath);
  runGit(["config", "user.name", "test"], repoPath);
  writeFixtureFiles(repoPath, files);
  runGit(["add", "."], repoPath);
  runGit(["commit", "-qm", "init"], repoPath);

  return {
    gitlabUrl: groupDir,
    projectPath: name,
    repoPath,
    groupDir,
    /** Overwrite/add files and commit, to exercise reindex's diff logic. */
    commitChange: (changedFiles: Record<string, string>) => {
      writeFixtureFiles(repoPath, changedFiles);
      runGit(["add", "."], repoPath);
      runGit(["commit", "-qm", "update"], repoPath);
    },
    // Fixtures sharing an existingGroupDir don't own the temp dir --
    // only the fixture that created it cleans it up.
    cleanup: () => {
      if (!base) return;
      try {
        Deno.removeSync(base, { recursive: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch stub -- intercepts only /embeddings and GitLab's /api/v4/ paths,
// passing everything else through to the real fetch.
// ---------------------------------------------------------------------------

function stubExternalFetch(opts?: { gitlabProjects?: Array<Record<string, unknown>> }) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/embeddings")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { input: string[] };
      const data = body.input.map((_text: string, index: number) => ({
        index,
        embedding: Array.from({ length: 8 }, (_, i) => (i === index % 8 ? 1 : 0.01)),
      }));
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    if (url.includes("/api/v4/")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts?.gitlabProjects ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    return original(input, init);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: index
// ---------------------------------------------------------------------------

Deno.test("index - clones a real repo, chunks, embeds, and writes a queryable index", async () => {
  const stub = stubExternalFetch();
  const fixture = createFixtureRepo({
    "README.md": "This service manages the nightly backup process for the platform.",
    "src/app.ts": "export function run() { return 'ok'; }",
  });
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixture.gitlabUrl },
    });

    const result = await model.methods.index.execute(
      { projectPath: fixture.projectPath },
      context,
    );
    assertEquals(result.dataHandles.length, 1);

    const index = store.get("myrepo")!.data as any;
    assertEquals(index.repo, "myrepo");
    assertEquals(index.filesIndexed, 2);
    assertEquals(index.chunkCount > 0, true);
    assertEquals(typeof index.commitSha, "string");
    assertEquals(index.commitSha.length, 40);
    assertEquals(typeof index.db, "string");
    assertEquals(index.db.length > 0, true);
  } finally {
    stub.restore();
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: index_batch
// ---------------------------------------------------------------------------

Deno.test("index_batch - indexes multiple repos in a single call", async () => {
  const stub = stubExternalFetch();
  const fixtureA = createFixtureRepo(
    { "README.md": "backup service for the platform" },
    { name: "repo-a" },
  );
  const fixtureB = createFixtureRepo(
    { "README.md": "billing service handles invoices" },
    { name: "repo-b", existingGroupDir: fixtureA.groupDir },
  );
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixtureA.gitlabUrl },
    });

    const result = await model.methods.index_batch.execute(
      { projectPaths: ["repo-a", "repo-b"] },
      context,
    );
    // One index resource per repo, plus the batch summary resource.
    assertEquals(result.dataHandles.length, 3);

    const indexA = store.get("repo-a")!.data as any;
    const indexB = store.get("repo-b")!.data as any;
    assertEquals(indexA.repo, "repo-a");
    assertEquals(indexB.repo, "repo-b");
    assertEquals(indexA.chunkCount > 0, true);
    assertEquals(indexB.chunkCount > 0, true);

    const summary = [...store.values()].find(
      (r) => r.specName === "index-batch-result",
    )!.data as any;
    assertEquals(summary.succeeded, ["repo-a", "repo-b"]);
    assertEquals(summary.failed, []);
    assertEquals(summary.totalRequested, 2);
  } finally {
    stub.restore();
    fixtureB.cleanup();
    fixtureA.cleanup();
  }
});

Deno.test("index_batch - a failing repo doesn't abort the rest of the batch", async () => {
  const stub = stubExternalFetch();
  const fixtureA = createFixtureRepo(
    { "README.md": "backup service for the platform" },
    { name: "repo-a" },
  );
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixtureA.gitlabUrl },
    });

    // "repo-missing" doesn't exist under the fixture group -- its clone
    // will fail, exercising the per-repo failure path.
    const result = await model.methods.index_batch.execute(
      { projectPaths: ["repo-a", "repo-missing"] },
      context,
    );
    // Only repo-a's index resource, plus the batch summary.
    assertEquals(result.dataHandles.length, 2);

    const indexA = store.get("repo-a")!.data as any;
    assertEquals(indexA.repo, "repo-a");

    const summary = [...store.values()].find(
      (r) => r.specName === "index-batch-result",
    )!.data as any;
    assertEquals(summary.succeeded, ["repo-a"]);
    assertEquals(summary.failed.length, 1);
    assertEquals(summary.failed[0].repo, "repo-missing");
    assertEquals(typeof summary.failed[0].error, "string");
    assertEquals(summary.totalRequested, 2);
  } finally {
    stub.restore();
    fixtureA.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: status
// ---------------------------------------------------------------------------

Deno.test("status - returns index metadata after indexing", async () => {
  const stub = stubExternalFetch();
  const fixture = createFixtureRepo({ "README.md": "backup service" });
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixture.gitlabUrl },
    });
    await model.methods.index.execute({ projectPath: fixture.projectPath }, context);

    const result = await model.methods.status.execute(
      { repo: fixture.projectPath },
      context,
    );
    const output = store.get(result.dataHandles[0].name)!.data as any;
    assertEquals(output.repo, fixture.projectPath);
    assertEquals(output.chunkCount > 0, true);
    assertEquals(output.commitSha.length, 40);
  } finally {
    stub.restore();
    fixture.cleanup();
  }
});

Deno.test("status - throws a clear error when no index exists", async () => {
  const { context } = createRepoIndexerTestContext();
  await (async () => {
    let threw = false;
    try {
      await model.methods.status.execute({ repo: "never/indexed" }, context);
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("No index found"), true);
    }
    assertEquals(threw, true);
  })();
});

// ---------------------------------------------------------------------------
// Tests: search
// ---------------------------------------------------------------------------

Deno.test("search - finds content in the exported index by keyword", async () => {
  const stub = stubExternalFetch();
  const fixture = createFixtureRepo({
    "README.md": "This service manages the nightly backup process for the platform.",
    "src/app.ts": "export function run() { return 'ok'; }",
  });
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixture.gitlabUrl },
    });
    await model.methods.index.execute({ projectPath: fixture.projectPath }, context);

    const result = await model.methods.search.execute(
      { repo: fixture.projectPath, query: "backup" },
      context,
    );
    const output = store.get(result.dataHandles[0].name)!.data as any;
    assertEquals(output.results.length > 0, true);
    assertEquals(
      output.results.some((r: any) => r.content.includes("backup")),
      true,
    );
  } finally {
    stub.restore();
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: reindex
// ---------------------------------------------------------------------------

Deno.test("reindex - falls back to a full index when none exists yet", async () => {
  const stub = stubExternalFetch();
  const fixture = createFixtureRepo({ "README.md": "backup service" });
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixture.gitlabUrl },
    });

    await model.methods.reindex.execute({ projectPath: fixture.projectPath }, context);
    const index = store.get("myrepo")!.data as any;
    assertEquals(index.chunkCount > 0, true);
    assertEquals(index.filesIndexed, 1);
  } finally {
    stub.restore();
    fixture.cleanup();
  }
});

Deno.test("reindex - incrementally re-embeds only what changed", async () => {
  const stub = stubExternalFetch();
  const fixture = createFixtureRepo({
    "README.md": "backup service readme",
    "unchanged.md": "static content that never changes",
  });
  try {
    const { context, store } = createRepoIndexerTestContext({
      globalArgs: { gitlabUrl: fixture.gitlabUrl },
    });
    await model.methods.index.execute({ projectPath: fixture.projectPath }, context);
    const before = store.get("myrepo")!.data as any;

    fixture.commitChange({ "README.md": "backup service readme, now updated with more detail" });

    const result = await model.methods.reindex.execute(
      { projectPath: fixture.projectPath },
      context,
    );
    assertEquals(result.dataHandles.length, 1);

    const after = store.get("myrepo")!.data as any;
    assertEquals(after.chunkCount > 0, true);
    // Commit sha must move -- the repo genuinely changed.
    assertEquals(after.commitSha !== before.commitSha, true);
  } finally {
    stub.restore();
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: discover
// ---------------------------------------------------------------------------

Deno.test("discover - returns repos from the GitLab API", async () => {
  const stub = stubExternalFetch({
    gitlabProjects: [
      {
        path_with_namespace: "org/repo-a",
        last_activity_at: "2026-01-01T00:00:00Z",
        visibility: "private",
      },
    ],
  });
  try {
    const { context, store } = createRepoIndexerTestContext();
    const result = await model.methods.discover.execute({}, context);
    const output = store.get(result.dataHandles[0].name)!.data as any;
    assertEquals(output.totalFound, 1);
    assertEquals(output.repos[0].path, "org/repo-a");
  } finally {
    stub.restore();
  }
});

Deno.test("discover - stops paginating once a short page comes back", async () => {
  // Single page shorter than perPage should end the loop after page 1,
  // not fetch maxPages worth of empty pages.
  let fetchCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v4/")) {
      fetchCalls++;
      return Promise.resolve(
        new Response(JSON.stringify([{ path_with_namespace: "org/only-one" }]), {
          status: 200,
        }),
      );
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const { context } = createRepoIndexerTestContext();
    await model.methods.discover.execute({ maxPages: 10 }, context);
    assertEquals(fetchCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Tests: list-indexed
// ---------------------------------------------------------------------------

function indexResource(
  name: string,
  repo: string,
  chunkCount: number,
  indexedAt: string,
): StoredResource {
  const data = {
    repo,
    commitSha: "abc123",
    chunkCount,
    filesIndexed: 1,
    indexedAt,
    dbSizeBytes: 1024,
    db: "ZmFrZQ==",
  };
  return {
    name,
    specName: "index",
    tags: { specName: "index" },
    data,
    content: new TextEncoder().encode(JSON.stringify(data)),
  };
}

Deno.test("list-indexed - lists all indexed repos sorted by most recent", async () => {
  const { context, store } = createRepoIndexerTestContext({
    seed: [
      indexResource("org--a", "org/a", 10, "2026-01-01T00:00:00.000Z"),
      indexResource("org--b", "org/b", 20, "2026-01-02T00:00:00.000Z"),
    ],
  });

  const result = await (model.methods as any)["list-indexed"].execute({}, context);
  const output = store.get(result.dataHandles[0].name)!.data as any;
  assertEquals(output.totalIndexed, 2);
  assertEquals(output.repos[0].repo, "org/b");
  assertEquals(output.repos[1].repo, "org/a");
});

// ---------------------------------------------------------------------------
// Tests: list-searches
// ---------------------------------------------------------------------------

function searchResource(
  name: string,
  repo: string,
  query: string,
  searchedAt: string,
): StoredResource {
  const data = { repo, query, results: [], totalChunks: 0, searchedAt };
  return {
    name,
    specName: "search",
    tags: { specName: "search" },
    data,
    content: new TextEncoder().encode(JSON.stringify(data)),
  };
}

Deno.test("list-searches - filters to the requested repo only", async () => {
  const { context, store } = createRepoIndexerTestContext({
    seed: [
      searchResource("a--1", "org/a", "q1", "2026-01-01T00:00:00.000Z"),
      searchResource("b--1", "org/b", "q2", "2026-01-01T00:00:00.000Z"),
    ],
  });

  const result = await (model.methods as any)["list-searches"].execute(
    { repo: "org/a" },
    context,
  );
  const output = store.get(result.dataHandles[0].name)!.data as any;
  assertEquals(output.total, 1);
  assertEquals(output.searches[0].repo, "org/a");
});

Deno.test("list-searches - returns searches across all repos when repo is omitted", async () => {
  const { context, store } = createRepoIndexerTestContext({
    seed: [
      searchResource("a--1", "org/a", "q1", "2026-01-01T00:00:00.000Z"),
      searchResource("b--1", "org/b", "q2", "2026-01-01T00:00:00.000Z"),
    ],
  });

  const result = await (model.methods as any)["list-searches"].execute({}, context);
  const output = store.get(result.dataHandles[0].name)!.data as any;
  assertEquals(output.total, 2);
});

Deno.test("list-searches - sorts most recent first", async () => {
  const { context, store } = createRepoIndexerTestContext({
    seed: [
      searchResource("a--1", "org/a", "older", "2026-01-01T00:00:00.000Z"),
      searchResource("a--2", "org/a", "newer", "2026-01-02T00:00:00.000Z"),
    ],
  });

  const result = await (model.methods as any)["list-searches"].execute(
    { repo: "org/a" },
    context,
  );
  const output = store.get(result.dataHandles[0].name)!.data as any;
  assertEquals(output.searches[0].query, "newer");
  assertEquals(output.searches[1].query, "older");
});

Deno.test("list-searches - ignores non-search resources", async () => {
  const { context, store } = createRepoIndexerTestContext({
    seed: [
      indexResource("org--a", "org/a", 5, "2026-01-01T00:00:00.000Z"),
      searchResource("a--1", "org/a", "q1", "2026-01-01T00:00:00.000Z"),
    ],
  });

  const result = await (model.methods as any)["list-searches"].execute({}, context);
  const output = store.get(result.dataHandles[0].name)!.data as any;
  assertEquals(output.total, 1);
});
