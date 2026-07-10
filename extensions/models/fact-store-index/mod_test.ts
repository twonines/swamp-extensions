// ABOUTME: Unit tests for @twonines/fact-store-index's model methods (export, search).
// ABOUTME: Exercises the actual swamp-facing wrappers via a mock context; the underlying
// ABOUTME: SQLite/RRF machinery has its own deeper coverage in _lib/impl_test.ts.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { model } from "./mod.ts";
import type { TruthPacket } from "./mod.ts";

// ---------------------------------------------------------------------------
// Mock context factory — mirrors the pattern used by @twonines/fact-store's
// and @twonines/repo-indexer's own mod_test.ts files.
// ---------------------------------------------------------------------------

function createExporterTestContext() {
  const store = new Map<string, Record<string, unknown>>();

  const writeResource = (
    _specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }> => {
    store.set(name, data);
    return Promise.resolve({ name });
  };

  const readResource = (name: string): Promise<Record<string, unknown> | null> => {
    return Promise.resolve(store.get(name) ?? null);
  };

  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  return { store, logger, writeResource, readResource };
}

const TEST_KEYWORDS = ["backup", "owner"];
function fakeEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return TEST_KEYWORDS.map((k) => (lower.includes(k) ? 1 : 0.01));
}

function stubEmbeddingsFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/embeddings")) return original(input, init);
    const body = JSON.parse(init!.body as string) as { input: string[] };
    const data = body.input.map((text: string, index: number) => ({
      index,
      embedding: fakeEmbedding(text),
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

const SAMPLE_TRUTH_PACKET: TruthPacket = {
  facts: [
    {
      id: "f-backup",
      kind: "repository_manages_aws_backup_service",
      scope: "myorg/backups",
      subjectRef: {
        refType: "repository",
        identityKind: "gitlab_path",
        identityValue: "myorg/backups",
      },
      value: "backup backup backup",
      authorityBasis: "file_is_the_mechanism",
      status: "active",
    },
  ],
  constraints: [],
};

function testGlobalArgs(tmpPath: string) {
  return {
    output_path: tmpPath,
    embed_url: "http://fake.test/v1",
    embed_model: "test-embed-model",
    embed_dim: TEST_KEYWORDS.length,
    embed_token: "test-token",
    batch_size: 32,
    truth_packet: SAMPLE_TRUTH_PACKET,
  };
}

Deno.test("export - writes both a state resource and a portable index resource", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const { store, logger, writeResource } = createExporterTestContext();
    const context = { globalArgs: testGlobalArgs(tmpPath), logger, writeResource };

    const result = await (model.methods.export.execute as any)({}, context);
    assertEquals(result.dataHandles.length, 2);

    const state = store.get("snapshot") as any;
    assertEquals(state.fact_count, 1);
    assertEquals(state.constraint_count, 0);

    const index = store.get("current") as any;
    assertEquals(typeof index.db, "string");
    assertEquals(index.db.length > 0, true);
    assertEquals(index.fact_count, 1);
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});

Deno.test("search - finds the exported fact by content, via the index resource", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const { store, logger, writeResource, readResource } = createExporterTestContext();
    const context = { globalArgs: testGlobalArgs(tmpPath), logger, writeResource, readResource };

    await (model.methods.export.execute as any)({}, context);

    const result = await (model.methods.search.execute as any)(
      { query: "backup", limit: 5 },
      context,
    );
    const output = store.get(result.dataHandles[0].name) as any;
    assertEquals(output.facts.length > 0, true);
    assertEquals(output.facts[0].kind, "repository_manages_aws_backup_service");
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});

Deno.test("search - throws a clear error when no index has been exported yet", async () => {
  const { logger, writeResource, readResource } = createExporterTestContext();
  const context = { globalArgs: testGlobalArgs("/tmp/unused.db"), logger, writeResource, readResource };

  await assertRejects(
    () => (model.methods.search.execute as any)({ query: "anything" }, context),
    Error,
    "No index found",
  );
});
