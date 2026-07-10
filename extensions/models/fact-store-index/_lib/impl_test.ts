// ABOUTME: Unit tests for @twonines/fact-store-index's _lib/impl.ts.
// ABOUTME: Covers pure helpers (tierForBasis, flatten*, floatToBlob, expandUserPath) plus an
// ABOUTME: end-to-end export+search round trip against a stubbed embeddings endpoint.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  expandUserPath,
  flattenConstraint,
  flattenFact,
  floatToBlob,
  type Logger,
  runExport,
  runSearch,
  tierForBasis,
} from "./impl.ts";
import type { GlobalArgs, TruthPacket } from "../mod.ts";

// ---------------------------------------------------------------------------
// tierForBasis
// ---------------------------------------------------------------------------

Deno.test("tierForBasis - maps every known basis to its documented tier", () => {
  assertEquals(tierForBasis("live_system_verification"), 0);
  assertEquals(tierForBasis("file_is_the_mechanism"), 1);
  assertEquals(tierForBasis("file_content_observation"), 2);
  assertEquals(tierForBasis("human_claim_in_file"), 3);
  assertEquals(tierForBasis("human_claim_in_ticket"), 3);
  assertEquals(tierForBasis("agent_inference"), 4);
});

Deno.test("tierForBasis - unknown basis falls back to the weakest tier", () => {
  assertEquals(tierForBasis("something_made_up"), 4);
});

// ---------------------------------------------------------------------------
// flattenFact / flattenConstraint
// ---------------------------------------------------------------------------

const SAMPLE_FACT: TruthPacket["facts"][number] = {
  id: "f1",
  kind: "repository_manages_aws_backup_service",
  scope: "myorg/backups",
  subjectRef: {
    refType: "repository",
    identityKind: "gitlab_path",
    identityValue: "myorg/backups",
  },
  value: "backs up nightly via CDK",
  authorityBasis: "file_is_the_mechanism",
  status: "active",
  proposedBy: "ferret-agent",
};

Deno.test("flattenFact - includes kind, scope, and value in the searchable text", () => {
  const text = flattenFact(SAMPLE_FACT);
  assertEquals(text.includes("repository_manages_aws_backup_service"), true);
  assertEquals(text.includes("myorg/backups"), true);
  assertEquals(text.includes("backs up nightly via CDK"), true);
});

Deno.test("flattenConstraint - includes rule and rationale in the searchable text", () => {
  const text = flattenConstraint({
    id: "c1",
    kind: "security_boundary",
    scope: "global",
    rule: "Never log secret values",
    rationale: "logs are shipped to a third party",
    status: "active",
  });
  assertEquals(text.includes("Never log secret values"), true);
  assertEquals(text.includes("logs are shipped to a third party"), true);
});

// ---------------------------------------------------------------------------
// floatToBlob
// ---------------------------------------------------------------------------

Deno.test("floatToBlob - produces bytes that decode back to the original vector", () => {
  const original = new Float32Array([0.5, -1.25, 3, 0]);
  const blob = floatToBlob(original);
  assertEquals(blob.byteLength, original.byteLength);
  // Local decode — blobToFloat isn't exported, but a fresh copy over the
  // same bytes is all this test needs to confirm nothing got mangled.
  const decoded = new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
  assertEquals(Array.from(decoded), Array.from(original));
});

// ---------------------------------------------------------------------------
// expandUserPath
// ---------------------------------------------------------------------------

Deno.test("expandUserPath - expands a leading ~/ against HOME", () => {
  const home = Deno.env.get("HOME");
  if (!home) return; // nothing to assert in an environment without HOME
  assertEquals(expandUserPath("~/foo/bar"), `${home}/foo/bar`);
});

Deno.test("expandUserPath - leaves absolute paths unchanged", () => {
  assertEquals(expandUserPath("/tmp/foo.db"), "/tmp/foo.db");
});

// ---------------------------------------------------------------------------
// runExport + runSearch — end-to-end round trip against a stubbed embeddings
// endpoint. Only the embeddings call is intercepted; the sqlite3-wasm binary
// still loads for real, so this exercises the actual SQLite build/deserialize
// path, not a mock of it.
// ---------------------------------------------------------------------------

/** Keyword axes for a small, deterministic fake embedding space. */
const TEST_KEYWORDS = ["backup", "owner", "deploy", "secret"];

function fakeEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return TEST_KEYWORDS.map((k) => (lower.includes(k) ? 1 : 0.01));
}

/**
 * Intercepts only requests to an `/embeddings` path, returning a
 * deterministic fake vector per input text. Everything else (notably the
 * sqlite3.wasm binary fetch) passes through to the real `fetch`.
 */
function stubEmbeddingsFetch() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/embeddings")) {
      return original(input, init);
    }
    calls++;
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
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function testLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function baseGlobalArgs(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    output_path: "",
    embed_url: "http://fake.test/v1",
    embed_model: "test-embed-model",
    embed_dim: TEST_KEYWORDS.length,
    embed_token: "test-token",
    batch_size: 32,
    truth_packet: { facts: [], constraints: [] },
    ...overrides,
  } as GlobalArgs;
}

const FACT_BACKUP: TruthPacket["facts"][number] = {
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
};

const FACT_OWNER: TruthPacket["facts"][number] = {
  id: "f-owner",
  kind: "repository_owned_by_team",
  scope: "myorg/backups",
  subjectRef: {
    refType: "repository",
    identityKind: "gitlab_path",
    identityValue: "myorg/backups",
  },
  value: "owner owner owner",
  authorityBasis: "human_claim_in_file",
  status: "active",
};

const CONSTRAINT_SECRET: TruthPacket["constraints"][number] = {
  id: "c-secret",
  kind: "security_boundary",
  scope: "global",
  rule: "secret secret secret",
  status: "active",
};

Deno.test("runExport - embeds and writes both the state and the raw bytes", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const truth_packet: TruthPacket = {
      facts: [FACT_BACKUP, FACT_OWNER],
      constraints: [CONSTRAINT_SECRET],
    };
    const { state, bytes } = await runExport(
      truth_packet,
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
    );

    assertEquals(state.fact_count, 2);
    assertEquals(state.constraint_count, 1);
    assertEquals(state.output_bytes, bytes.byteLength);
    assertEquals(bytes.byteLength > 0, true);
    assertNotEquals(state.sha256, "");

    // Embedding was actually invoked (not skipped) for a non-empty corpus.
    assertEquals(stub.callCount() > 0, true);

    // The file was really written to output_path, not just returned.
    const written = await Deno.readFile(tmpPath);
    assertEquals(written.byteLength, bytes.byteLength);
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});

Deno.test("runExport - empty corpus skips the embeddings call entirely", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const truth_packet: TruthPacket = { facts: [], constraints: [] };
    const { state } = await runExport(
      truth_packet,
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
    );

    assertEquals(state.fact_count, 0);
    assertEquals(state.constraint_count, 0);
    assertEquals(stub.callCount(), 0);
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});

Deno.test("runSearch - ranks the fact whose content matches the query highest", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const truth_packet: TruthPacket = {
      facts: [FACT_BACKUP, FACT_OWNER],
      constraints: [CONSTRAINT_SECRET],
    };
    const { bytes } = await runExport(
      truth_packet,
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
    );

    const backupResult = await runSearch(
      bytes,
      "backup",
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
      5,
    );
    assertEquals(backupResult.facts.length > 0, true);
    assertEquals(backupResult.facts[0].kind, FACT_BACKUP.kind);

    const ownerResult = await runSearch(
      bytes,
      "owner",
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
      5,
    );
    assertEquals(ownerResult.facts.length > 0, true);
    assertEquals(ownerResult.facts[0].kind, FACT_OWNER.kind);

    const secretResult = await runSearch(
      bytes,
      "secret",
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
      5,
    );
    assertEquals(secretResult.constraints.length > 0, true);
    assertEquals(secretResult.constraints[0].kind, CONSTRAINT_SECRET.kind);
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});

Deno.test("runSearch - reassembles fact fields correctly, not just the ranking", async () => {
  const stub = stubEmbeddingsFetch();
  const tmpPath = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const truth_packet: TruthPacket = {
      facts: [FACT_BACKUP],
      constraints: [],
    };
    const { bytes } = await runExport(
      truth_packet,
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
    );

    const result = await runSearch(
      bytes,
      "backup",
      baseGlobalArgs({ output_path: tmpPath, truth_packet }),
      testLogger(),
      5,
    );
    const hit = result.facts[0];
    assertEquals(hit.id, FACT_BACKUP.id);
    assertEquals(hit.scope, FACT_BACKUP.scope);
    assertEquals(hit.subjectRef, FACT_BACKUP.subjectRef);
    assertEquals(hit.value, FACT_BACKUP.value);
    assertEquals(hit.authorityBasis, FACT_BACKUP.authorityBasis);
  } finally {
    stub.restore();
    await Deno.remove(tmpPath).catch(() => {});
  }
});
