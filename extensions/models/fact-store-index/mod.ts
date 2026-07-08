/**
 * Exporter model for @twonines/fact-store-index.
 *
 * Takes the truth-packet output of `@twonines/fact-store`'s `query`
 * method, computes embeddings against any OpenAI-compatible endpoint,
 * and writes a portable SQLite file (FTS5 full-text indexes + raw f32
 * vector BLOBs) that downstream consumers can open for sub-100ms
 * hybrid retrieval.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";
import { runExport } from "./_lib/impl.ts";

// ---------------------------------------------------------------------------
// Truth-packet input schemas (defined before GlobalArgs so the packet can
// be a globalArgument — that's the only shape where a `data.latest(...)`
// CEL wiring evaluates. See the truth_packet field docstring below.)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `subjectRef` block that identifies a fact's
 * subject. Matches the shape emitted by `@twonines/fact-store`.
 */
const SubjectRefSchema = z.object({
  refType: z.string(),
  identityKind: z.string(),
  identityValue: z.string(),
});

/**
 * Zod schema for a single active fact as emitted by fact-store's
 * `query` method. Only the fields the exporter reads are required —
 * additional fields are ignored so upstream schema growth doesn't
 * break the export.
 */
const FactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.string().default("global"),
  subjectRef: SubjectRefSchema,
  value: z.unknown(),
  authorityBasis: z.string(),
  status: z.string().default("active"),
  proposedBy: z.string().optional(),
  activatedBy: z.string().optional(),
  createdAt: z.string().optional(),
  activatedAt: z.string().optional(),
  evidence: z.array(z.string()).optional(),
}).loose();

/**
 * Zod schema for a single active constraint. Constraints are
 * human-curated behavioral rules, distinct from evidence-derived facts.
 */
const ConstraintSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.string().default("global"),
  rule: z.string(),
  rationale: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
  status: z.string().default("active"),
  createdAt: z.string().optional(),
}).loose();

/**
 * Zod schema for the truth-packet — the `attributes` object emitted by
 * `@twonines/fact-store`'s `query` method. Wired into globalArguments
 * so `data.latest(...)` CEL expressions resolve at method-invocation
 * time.
 */
export const TruthPacketSchema = z.object({
  facts: z.array(FactSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
}).loose();

/** Inferred truth-packet type. */
export type TruthPacket = z.infer<typeof TruthPacketSchema>;

// ---------------------------------------------------------------------------
// GlobalArguments — per-instance configuration, including the wired-in
// truth packet reference.
// ---------------------------------------------------------------------------

/**
 * Zod schema for the exporter's globalArguments — configuration that
 * stays stable across invocations of the same model instance, plus the
 * `truth_packet` data reference that resolves fresh on every method
 * call.
 */
export const GlobalArgsSchema = z.object({
  output_path: z
    .string()
    .min(1)
    .default("~/.jitter/facts.db")
    .describe(
      "Absolute path (or ~/-prefixed) where the SQLite file will be " +
        "written. Parent directories are created if missing.",
    ),
  embed_url: z
    .string()
    .url()
    .default("https://api.openai.com/v1")
    .describe(
      "OpenAI-compatible embeddings API base URL. `/embeddings` is " +
        "appended at request time. Point this at OpenAI, a LiteLLM " +
        "proxy, or any compatible self-hosted inference server.",
    ),
  embed_model: z
    .string()
    .min(1)
    .default("text-embedding-3-small")
    .describe(
      "Embedding model identifier. Recorded in the SQLite manifest so " +
        "consumers can validate compatibility at query time.",
    ),
  embed_dim: z
    .number()
    .int()
    .positive()
    .default(1536)
    .describe(
      "Expected embedding dimension. Rows whose returned embedding does " +
        "not match are rejected — mismatched dimensions across a corpus " +
        "silently corrupt cosine-similarity search.",
    ),
  embed_token: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Bearer token for the embeddings API. Source from a swamp vault " +
        "via `${{ vault.get(...) }}` — never inline.",
    ),
  batch_size: z
    .number()
    .int()
    .positive()
    .max(2048)
    .default(32)
    .describe(
      "Maximum number of texts included in a single embeddings API " +
        "request. Larger batches reduce round-trips; provider limits may " +
        "cap this. OpenAI accepts up to 2048.",
    ),
  truth_packet: TruthPacketSchema.describe(
    "Facts + constraints to index — the `attributes` object emitted by " +
      "`@twonines/fact-store`'s `query` method. Wire from `${{ " +
      'data.latest("<facts-model-name>", "query--global").attributes ' +
      "}}` in the model instance yaml. Lives on globalArguments rather " +
      "than method arguments because workflow-step `task.inputs` " +
      "strings do not evaluate `data.latest(...)` — globalArguments do.",
  ),
});

/** Inferred type of the exporter's globalArguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Output resource
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `state` resource written after each successful
 * export. Records everything a consumer needs to verify the export is
 * fresh and dimensionally compatible with their query-side embedder.
 */
export const StateSchema = z.object({
  exported_at: z.string().describe("ISO-8601 timestamp of the export"),
  output_path: z.string().describe("Path the SQLite file was written to"),
  embed_url: z.string(),
  embed_model: z.string(),
  embed_dim: z.number().int(),
  fact_count: z.number().int(),
  constraint_count: z.number().int(),
  output_bytes: z
    .number()
    .int()
    .describe("Size of the resulting SQLite file in bytes"),
  sha256: z
    .string()
    .describe("SHA-256 checksum of the SQLite file for freshness detection"),
});

/** Inferred state type. */
export type State = z.infer<typeof StateSchema>;

// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Model definition for `@twonines/fact-store-index/exporter`. The
 * single `export` method reads the current truth-packet from
 * globalArguments, computes embeddings for every fact and constraint
 * against the configured OpenAI-compatible endpoint, and writes a
 * self-contained SQLite file with FTS5 indexes and raw f32 vector
 * BLOBs to `output_path`. Emits one `state` resource describing the
 * export.
 */
export const model = {
  type: "@twonines/fact-store-index/exporter",
  version: "2026.07.07.1",
  description:
    "Exporter that materializes @twonines/fact-store contents into a " +
    "SQLite file with FTS5 + vector embeddings for downstream " +
    "hybrid-search consumers.",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "Summary of a fact-store-index export run: path, checksum, " +
        "counts, and embedding-model coordinates.",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    export: {
      description:
        "Build a fresh SQLite index from the truth_packet globalArgument " +
        "and write it to output_path. Idempotent — rewrites the file on " +
        "every call. Takes no method arguments; wire the truth packet " +
        "via globalArguments in the model instance yaml.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs as GlobalArgs;
        const state = await runExport(g.truth_packet, g, context.logger);
        const handle = await context.writeResource("state", "snapshot", state);
        context.logger.info(
          "fact-store-index export complete: {facts} facts, {constraints} constraints, {bytes} bytes",
          {
            facts: state.fact_count,
            constraints: state.constraint_count,
            bytes: state.output_bytes,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
