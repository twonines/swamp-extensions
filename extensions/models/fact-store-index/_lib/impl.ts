/**
 * Implementation details for the fact-store-index exporter.
 *
 * Separated from `mod.ts` so tests can import the helpers directly and
 * the model entrypoint stays a narrow surface. Nothing in this file
 * depends on swamp's model runtime — the only external I/O is `fetch`
 * (embeddings API + WASM binary on first call) and `Deno.writeFile`
 * (SQLite output).
 *
 * The exporter emits a portable SQLite file with FTS5 full-text indexes
 * and raw f32 vector BLOBs. Consumers open the file, validate
 * `manifest.embed_model` / `manifest.embed_dim` against their own
 * query-side embedder, and combine BM25 (via FTS5) with cosine
 * similarity (over the BLOBs) for hybrid retrieval.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix no-explicit-any
// Deno's default condition set on Node-flavored bundles is
// ["deno", "node", "import", "default"], so this package's exports
// map resolves to `dist/node.mjs` — the direct (non-Worker) sync
// API. The `import`/`browser` condition would give a Worker-based
// promiser that requires `postMessage` and doesn't fit the swamp
// extension sandbox.
import sqlite3InitModule from "npm:@sqlite.org/sqlite-wasm@3.53.0-build1";
import type { GlobalArgs, State, TruthPacket } from "../mod.ts";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Minimal logger surface — matches what swamp passes as `context.logger`
 * and what tests can stub without pulling in the full swamp runtime.
 */
export interface Logger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Schema version bumped whenever the on-disk SQLite shape changes. */
const SCHEMA_VERSION = 1;

/**
 * Build the SQLite index and write it to `globalArgs.output_path`.
 *
 * Steps:
 *   1. Flatten every fact and constraint into a `searchable_text` string.
 *   2. Batch-embed all texts against the configured embeddings endpoint.
 *   3. Build an in-memory SQLite (FTS5 + BLOB embeddings) via
 *      @sqlite.org/sqlite-wasm.
 *   4. Serialize the database to bytes, checksum, and write to disk.
 */
export async function runExport(
  truthPacket: TruthPacket,
  globalArgs: GlobalArgs,
  logger: Logger,
): Promise<State> {
  const facts = truthPacket.facts ?? [];
  const constraints = truthPacket.constraints ?? [];

  logger.info(
    "fact-store-index export starting: {facts} facts, {constraints} constraints",
    { facts: facts.length, constraints: constraints.length },
  );

  const factTexts = facts.map(flattenFact);
  const constraintTexts = constraints.map(flattenConstraint);
  const allTexts = [...factTexts, ...constraintTexts];

  // Empty corpus is legitimate — skip the network call and emit a DB
  // with just the manifest so downstream tools have something
  // predictable to open.
  let allEmbeddings: Float32Array[] = [];
  if (allTexts.length > 0) {
    logger.info(
      "embedding {count} rows against {url} ({model}, dim={dim})",
      {
        count: allTexts.length,
        url: globalArgs.embed_url,
        model: globalArgs.embed_model,
        dim: globalArgs.embed_dim,
      },
    );
    allEmbeddings = await embedTexts(allTexts, globalArgs, logger);
  }
  const factEmbeddings = allEmbeddings.slice(0, factTexts.length);
  const constraintEmbeddings = allEmbeddings.slice(factTexts.length);

  const bytes = await buildSqlite(
    truthPacket,
    factTexts,
    factEmbeddings,
    constraintTexts,
    constraintEmbeddings,
    globalArgs,
    logger,
  );

  const path = expandUserPath(globalArgs.output_path);
  await ensureParentDir(path);
  await Deno.writeFile(path, bytes);
  const sha = await sha256Hex(bytes);

  return {
    exported_at: new Date().toISOString(),
    output_path: path,
    embed_url: globalArgs.embed_url,
    embed_model: globalArgs.embed_model,
    embed_dim: globalArgs.embed_dim,
    fact_count: facts.length,
    constraint_count: constraints.length,
    output_bytes: bytes.byteLength,
    sha256: sha,
  };
}

// ---------------------------------------------------------------------------
// SQLite construction — schema, inserts, FTS5, manifest
// ---------------------------------------------------------------------------

// URL for the sqlite3.wasm asset shipped by @sqlite.org/sqlite-wasm.
// Kept in sync with the import version above. When the extension runs
// in a bundled Deno context, the node.mjs entry's own filesystem-based
// WASM lookup fails (there's no `sqlite3.wasm` sibling next to a
// bundle). We fetch the WASM once from the npm CDN and hand it to
// `sqlite3InitModule` via `wasmBinary`.
const SQLITE_WASM_URL =
  "https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.53.0-build1.tgz";

// Cached WASM bytes and sqlite3 handle so repeated exports in the same
// process only pay the download / init cost once.
let cachedWasmBytes: Uint8Array | null = null;
let cachedSqlite3: any | null = null;

/**
 * Load the sqlite3 WASM handle, downloading and caching the WASM binary
 * on first call. Split out so failure modes (network unreachable,
 * tarball layout changed, wasmBinary rejected) are attributable rather
 * than hidden inside SQLite construction.
 */
async function loadSqlite3(logger: Logger): Promise<any> {
  if (cachedSqlite3) return cachedSqlite3;
  if (!cachedWasmBytes) {
    logger.info("loading sqlite3 wasm asset (first call this process)");
    cachedWasmBytes = await fetchSqliteWasm();
    logger.info("sqlite3 wasm loaded: {bytes} bytes", {
      bytes: cachedWasmBytes.byteLength,
    });
  }
  cachedSqlite3 =
    await (sqlite3InitModule as (config?: unknown) => Promise<any>)({
      wasmBinary: cachedWasmBytes,
    });
  return cachedSqlite3;
}

/**
 * Fetch and extract `dist/sqlite3.wasm` from the npm tarball. The
 * @sqlite.org/sqlite-wasm package's `./sqlite3.wasm` export points at
 * this asset. We can't rely on the package's own file-based loader in
 * a bundled extension, so we cache the bytes ourselves.
 */
async function fetchSqliteWasm(): Promise<Uint8Array> {
  const resp = await fetch(SQLITE_WASM_URL);
  if (!resp.ok) {
    throw new Error(
      `sqlite3.wasm fetch failed HTTP ${resp.status}: ${resp.statusText}`,
    );
  }
  const tarGz = new Uint8Array(await resp.arrayBuffer());
  return await extractWasmFromTgz(tarGz);
}

/**
 * Extract `package/dist/sqlite3.wasm` from a gzipped tar archive
 * without pulling in a third-party tar library. Uses Deno's
 * `DecompressionStream("gzip")` for gunzip, then walks the tar block
 * structure manually. Tar is a simple 512-byte-header format — worth
 * the ~40 lines vs. adding another npm dep for one file.
 */
async function extractWasmFromTgz(tarGz: Uint8Array): Promise<Uint8Array> {
  // Ungzip
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(tarGz as unknown as Uint8Array<ArrayBuffer>);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const tar = new Uint8Array(total);
  {
    let offset = 0;
    for (const c of chunks) {
      tar.set(c, offset);
      offset += c.byteLength;
    }
  }
  // Walk tar blocks looking for package/dist/sqlite3.wasm
  const target = "package/dist/sqlite3.wasm";
  const decoder = new TextDecoder("utf-8");
  let pos = 0;
  while (pos + 512 <= tar.byteLength) {
    const header = tar.subarray(pos, pos + 512);
    // File name is bytes 0-99, null-terminated
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(header.subarray(0, nameEnd));
    if (!name) break; // end of archive
    // File size is octal ASCII in bytes 124-135
    const sizeStr = decoder
      .decode(header.subarray(124, 136))
      .replace(/[\0 ]+$/g, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const dataStart = pos + 512;
    if (name === target) {
      return tar.subarray(dataStart, dataStart + size).slice();
    }
    // Advance past this entry's data, rounded up to 512-byte block
    const blocks = Math.ceil(size / 512);
    pos = dataStart + blocks * 512;
  }
  throw new Error(`sqlite3.wasm not found in tarball (looked for "${target}")`);
}

/**
 * Build the SQLite database in memory and return its bytes.
 */
async function buildSqlite(
  truthPacket: TruthPacket,
  factTexts: string[],
  factEmbeddings: Float32Array[],
  constraintTexts: string[],
  constraintEmbeddings: Float32Array[],
  cfg: GlobalArgs,
  logger: Logger,
): Promise<Uint8Array> {
  const sqlite3 = await loadSqlite3(logger);
  const db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    db.exec(SCHEMA_SQL);

    // Facts
    for (let i = 0; i < truthPacket.facts.length; i++) {
      const f = truthPacket.facts[i];
      const emb = factEmbeddings[i];
      db.exec({
        sql: `INSERT INTO facts (
                id, kind, scope, subject_ref_type, subject_identity_kind,
                subject_identity_value, value_json, authority_basis, tier,
                proposed_by, activated_by, created_at, activated_at,
                evidence_json, searchable_text, embedding
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          f.id,
          f.kind,
          f.scope,
          f.subjectRef.refType,
          f.subjectRef.identityKind,
          f.subjectRef.identityValue,
          JSON.stringify(f.value ?? null),
          f.authorityBasis,
          tierForBasis(f.authorityBasis),
          f.proposedBy ?? null,
          f.activatedBy ?? null,
          f.createdAt ?? null,
          f.activatedAt ?? null,
          JSON.stringify(f.evidence ?? []),
          factTexts[i],
          emb ? floatToBlob(emb) : null,
        ],
      });
      db.exec({
        sql: `INSERT INTO facts_fts (rowid, searchable_text) VALUES (?, ?)`,
        bind: [i + 1, factTexts[i]],
      });
    }

    // Constraints
    for (let i = 0; i < truthPacket.constraints.length; i++) {
      const c = truthPacket.constraints[i];
      const emb = constraintEmbeddings[i];
      db.exec({
        sql: `INSERT INTO constraints (
                id, kind, scope, rule, rationale, applies_to_json,
                created_at, searchable_text, embedding
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          c.id,
          c.kind,
          c.scope,
          c.rule,
          c.rationale ?? null,
          JSON.stringify(c.appliesTo ?? []),
          c.createdAt ?? null,
          constraintTexts[i],
          emb ? floatToBlob(emb) : null,
        ],
      });
      db.exec({
        sql:
          `INSERT INTO constraints_fts (rowid, searchable_text) VALUES (?, ?)`,
        bind: [i + 1, constraintTexts[i]],
      });
    }

    // Manifest — single row per DB, describes the export
    db.exec({
      sql: `INSERT INTO manifest (
              exported_at, embed_url, embed_model, embed_dim,
              fact_count, constraint_count, schema_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        new Date().toISOString(),
        cfg.embed_url,
        cfg.embed_model,
        cfg.embed_dim,
        truthPacket.facts.length,
        truthPacket.constraints.length,
        SCHEMA_VERSION,
      ],
    });

    const bytes = sqlite3.capi.sqlite3_js_db_export(db);
    return bytes as Uint8Array;
  } finally {
    db.close();
  }
}

/**
 * SQLite DDL for the exported index. Kept as a single string so a
 * consumer that opens the file can `.schema` and see the whole layout.
 */
const SCHEMA_SQL = `
  CREATE TABLE facts (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    subject_ref_type TEXT NOT NULL,
    subject_identity_kind TEXT NOT NULL,
    subject_identity_value TEXT NOT NULL,
    value_json TEXT NOT NULL,
    authority_basis TEXT NOT NULL,
    tier INTEGER NOT NULL,
    proposed_by TEXT,
    activated_by TEXT,
    created_at TEXT,
    activated_at TEXT,
    evidence_json TEXT NOT NULL,
    searchable_text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX facts_kind ON facts(kind);
  CREATE INDEX facts_subject ON facts(subject_identity_value);
  CREATE INDEX facts_tier ON facts(tier);

  CREATE VIRTUAL TABLE facts_fts USING fts5(searchable_text);

  CREATE TABLE constraints (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    rule TEXT NOT NULL,
    rationale TEXT,
    applies_to_json TEXT NOT NULL,
    created_at TEXT,
    searchable_text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX constraints_kind ON constraints(kind);

  CREATE VIRTUAL TABLE constraints_fts USING fts5(searchable_text);

  CREATE TABLE manifest (
    exported_at TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    embed_dim INTEGER NOT NULL,
    fact_count INTEGER NOT NULL,
    constraint_count INTEGER NOT NULL,
    schema_version INTEGER NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Fact / constraint flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a fact into a single searchable string. Combines every field a
 * consumer's keyword search or embedding-relevance check might match on.
 *
 * The exact format is not part of the extension's contract — it feeds
 * FTS5 and the embedding model. Consumers should read structured
 * columns (kind, subject_ref_type, value_json) rather than parsing this.
 */
export function flattenFact(fact: TruthPacket["facts"][number]): string {
  const parts: string[] = [];
  parts.push(`kind: ${fact.kind}`);
  parts.push(
    `subject: ${fact.subjectRef.refType} ${fact.subjectRef.identityKind}=${fact.subjectRef.identityValue}`,
  );
  parts.push(`scope: ${fact.scope}`);
  parts.push(`value: ${stringifyValue(fact.value)}`);
  parts.push(`basis: ${fact.authorityBasis}`);
  if (fact.proposedBy) parts.push(`proposedBy: ${fact.proposedBy}`);
  if (fact.evidence && fact.evidence.length > 0) {
    parts.push(`evidence: ${fact.evidence.join(", ")}`);
  }
  return parts.join(" | ");
}

/**
 * Flatten a constraint into a searchable string. Rule text carries the
 * bulk of semantic meaning; kind + scope + rationale + appliesTo tags
 * refine keyword and semantic matching.
 */
export function flattenConstraint(
  c: TruthPacket["constraints"][number],
): string {
  const parts: string[] = [];
  parts.push(`kind: ${c.kind}`);
  parts.push(`scope: ${c.scope}`);
  parts.push(`rule: ${c.rule}`);
  if (c.rationale) parts.push(`rationale: ${c.rationale}`);
  if (c.appliesTo && c.appliesTo.length > 0) {
    parts.push(`appliesTo: ${c.appliesTo.join(", ")}`);
  }
  return parts.join(" | ");
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Authority-basis → numeric tier
// ---------------------------------------------------------------------------

/**
 * Map the fact-store `authorityBasis` enum to a numeric tier (0 = best).
 * Both `human_claim_in_file` and `human_claim_in_ticket` collapse to 3;
 * unknown bases fall back to 4 (weakest).
 */
export function tierForBasis(basis: string): number {
  switch (basis) {
    case "live_system_verification":
      return 0;
    case "file_is_the_mechanism":
      return 1;
    case "file_content_observation":
      return 2;
    case "human_claim_in_file":
    case "human_claim_in_ticket":
      return 3;
    case "agent_inference":
      return 4;
    default:
      return 4;
  }
}

// ---------------------------------------------------------------------------
// Embeddings — OpenAI-compatible
// ---------------------------------------------------------------------------

/**
 * Batch-embed an array of texts against the configured OpenAI-compatible
 * endpoint. Preserves ordering. Throws on HTTP failure, on dimension
 * mismatch, or when the response doesn't contain one embedding per input.
 */
export async function embedTexts(
  texts: string[],
  cfg: GlobalArgs,
  logger: Logger,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const batchSize = cfg.batch_size;
  const url = joinUrl(cfg.embed_url, "embeddings");

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    logger.info("embedding batch {start}-{end} of {total}", {
      start: i,
      end: i + batch.length,
      total: texts.length,
    });
    const vecs = await embedOne(url, cfg, batch);
    for (let j = 0; j < vecs.length; j++) {
      out[i + j] = vecs[j];
    }
  }
  return out;
}

async function embedOne(
  url: string,
  cfg: GlobalArgs,
  batch: string[],
): Promise<Float32Array[]> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.embed_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.embed_model,
      input: batch,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `embeddings API ${resp.status} ${resp.statusText}: ${body.slice(0, 400)}`,
    );
  }
  const parsed = await resp.json() as {
    data?: Array<{ embedding: number[]; index?: number }>;
  };
  const data = parsed.data ?? [];
  if (data.length !== batch.length) {
    throw new Error(
      `embeddings API returned ${data.length} vectors for ${batch.length} inputs`,
    );
  }
  const sorted = new Array<Float32Array>(batch.length);
  for (let i = 0; i < data.length; i++) {
    const idx = data[i].index ?? i;
    const vec = data[i].embedding;
    if (vec.length !== cfg.embed_dim) {
      throw new Error(
        `embedding dim mismatch: got ${vec.length}, expected ${cfg.embed_dim}`,
      );
    }
    sorted[idx] = new Float32Array(vec);
  }
  return sorted;
}

function joinUrl(base: string, tail: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const t = tail.startsWith("/") ? tail.slice(1) : tail;
  return `${b}/${t}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Convert an f32 vector to raw little-endian bytes for storage in a
 * SQLite BLOB column. Consumers should read as Float32Array over the
 * same buffer (all mainstream platforms are little-endian).
 */
export function floatToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

/**
 * Expand a leading `~/` in a path to the user's HOME directory.
 * Returns the raw path unchanged otherwise.
 */
export function expandUserPath(p: string): string {
  if (p.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) return `${home}/${p.slice(2)}`;
  }
  return p;
}

async function ensureParentDir(filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf("/");
  if (idx <= 0) return;
  const parent = filePath.slice(0, idx);
  await Deno.mkdir(parent, { recursive: true });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as Uint8Array<ArrayBuffer>,
  );
  const hex: string[] = [];
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) {
    hex.push(view[i].toString(16).padStart(2, "0"));
  }
  return hex.join("");
}
