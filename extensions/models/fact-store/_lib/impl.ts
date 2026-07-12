/**
 * Shared implementation for `@twonines/fact-store`'s `export` and `search`
 * methods. Separated from `mod.ts` so the model entrypoint stays a narrow
 * surface and tests can import these helpers directly.
 *
 * `export` reads the store's own active facts/constraints, embeds them,
 * builds a self-contained SQLite database (FTS5 full-text indexes + raw
 * f32 vector BLOBs), writes it to local disk, and persists the same bytes
 * as a portable `index` resource. `search` reads that resource, embeds
 * only the query text, and runs hybrid FTS5 + vector search (RRF-fused)
 * against the already-embedded corpus — it does not re-embed facts or
 * constraints on every call.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix no-explicit-any
import sqlite3InitModule from "npm:@sqlite.org/sqlite-wasm@3.53.0-build1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Logger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
  error?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface GlobalArgs {
  embedUrl?: string;
  embedToken?: string;
  embedModel?: string;
  embedDim?: number;
  outputPath?: string;
  batchSize?: number;
}

export interface ExportFact {
  id: string;
  kind: string;
  scope: string;
  subjectRef: { refType: string; identityKind: string; identityValue: string };
  value: unknown;
  authorityBasis: string;
  proposedBy?: string;
  activatedBy?: string;
  createdAt?: string;
  activatedAt?: string;
  evidence?: string[];
}

export interface ExportConstraint {
  id: string;
  kind: string;
  scope: string;
  rule: string;
  rationale?: string;
  appliesTo?: string[];
  createdAt?: string;
}

export interface ExportState {
  exportedAt: string;
  outputPath: string;
  embedModel: string;
  embedDim: number;
  factCount: number;
  constraintCount: number;
  outputBytes: number;
  sha256: string;
}

export interface FactSearchHit {
  id: string;
  kind: string;
  scope: string;
  subjectRef: { refType: string; identityKind: string; identityValue: string };
  value: unknown;
  authorityBasis: string;
  proposedBy: string | null;
  activatedBy: string | null;
  createdAt: string | null;
  activatedAt: string | null;
  evidence: string[];
  score: number;
}

export interface ConstraintSearchHit {
  id: string;
  kind: string;
  scope: string;
  rule: string;
  rationale: string | null;
  appliesTo: string[];
  createdAt: string | null;
  score: number;
}

export interface SearchOutput {
  query: string;
  facts: FactSearchHit[];
  constraints: ConstraintSearchHit[];
  totalIndexed: number;
  searchedAt: string;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_EMBED_DIM = 1536;
const DEFAULT_OUTPUT_PATH = "~/.jitter/facts.db";
const DEFAULT_BATCH_SIZE = 32;

/**
 * Build the SQLite index from the store's own active facts/constraints,
 * write it to `globalArgs.outputPath`, and return the raw bytes alongside
 * the state summary so the caller can also persist the bytes as a
 * portable `index` resource.
 */
export async function runExport(
  facts: ExportFact[],
  constraints: ExportConstraint[],
  globalArgs: GlobalArgs,
  logger: Logger,
): Promise<{ state: ExportState; bytes: Uint8Array }> {
  if (!globalArgs.embedUrl || !globalArgs.embedToken) {
    throw new Error(
      "Export requires embedUrl and embedToken in globalArguments.",
    );
  }
  const embedModel = globalArgs.embedModel ?? DEFAULT_EMBED_MODEL;
  const embedDim = globalArgs.embedDim ?? DEFAULT_EMBED_DIM;
  const outputPath = expandUserPath(
    globalArgs.outputPath ?? DEFAULT_OUTPUT_PATH,
  );

  logger.info(
    "fact-store export starting: {facts} facts, {constraints} constraints",
    { facts: facts.length, constraints: constraints.length },
  );

  const factTexts = facts.map(flattenFact);
  const constraintTexts = constraints.map(flattenConstraint);
  const allTexts = [...factTexts, ...constraintTexts];

  let allEmbeddings: Float32Array[] = [];
  if (allTexts.length > 0) {
    allEmbeddings = await embedTexts(allTexts, globalArgs, logger);
  }
  const factEmbeddings = allEmbeddings.slice(0, factTexts.length);
  const constraintEmbeddings = allEmbeddings.slice(factTexts.length);

  const bytes = await buildSqlite(
    facts,
    factTexts,
    factEmbeddings,
    constraints,
    constraintTexts,
    constraintEmbeddings,
    globalArgs.embedUrl,
    embedModel,
    embedDim,
    logger,
  );

  await ensureParentDir(outputPath);
  await Deno.writeFile(outputPath, bytes);
  const sha = await sha256Hex(bytes);

  const state: ExportState = {
    exportedAt: new Date().toISOString(),
    outputPath,
    embedModel,
    embedDim,
    factCount: facts.length,
    constraintCount: constraints.length,
    outputBytes: bytes.byteLength,
    sha256: sha,
  };
  logger.info(
    "fact-store export complete: {facts} facts, {constraints} constraints, {bytes} bytes",
    {
      facts: facts.length,
      constraints: constraints.length,
      bytes: bytes.byteLength,
    },
  );
  return { state, bytes };
}

// ---------------------------------------------------------------------------
// Search — reads an already-built index, embeds only the query
// ---------------------------------------------------------------------------

const RRF_K = 60;
const FTS_CANDIDATES = 50;
const VEC_CANDIDATES = 50;
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Run hybrid search (FTS5 keyword + vector cosine, RRF-fused) against a
 * previously exported index. Only the query text is embedded here — the
 * corpus embeddings already live in `bytes` from when `export` ran.
 */
export async function runSearch(
  bytes: Uint8Array,
  queryText: string,
  globalArgs: GlobalArgs,
  logger: Logger,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchOutput> {
  if (!globalArgs.embedUrl || !globalArgs.embedToken) {
    throw new Error(
      "Search requires embedUrl and embedToken in globalArguments.",
    );
  }
  const db = await openDbFromBytes(bytes, logger);
  try {
    const [queryVec] = await embedTexts([queryText], globalArgs, logger);

    const facts = searchTable<FactSearchHit>(
      db,
      queryVec,
      queryText,
      limit,
      "facts",
      "facts_fts",
      (row) => ({
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        subjectRef: {
          refType: row.subject_ref_type,
          identityKind: row.subject_identity_kind,
          identityValue: row.subject_identity_value,
        },
        value: JSON.parse(row.value_json ?? "null"),
        authorityBasis: row.authority_basis,
        proposedBy: row.proposed_by ?? null,
        activatedBy: row.activated_by ?? null,
        createdAt: row.created_at ?? null,
        activatedAt: row.activated_at ?? null,
        evidence: JSON.parse(row.evidence_json ?? "[]"),
        score: 0,
      }),
    );

    const constraints = searchTable<ConstraintSearchHit>(
      db,
      queryVec,
      queryText,
      limit,
      "constraints",
      "constraints_fts",
      (row) => ({
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        rule: row.rule,
        rationale: row.rationale ?? null,
        appliesTo: JSON.parse(row.applies_to_json ?? "[]"),
        createdAt: row.created_at ?? null,
        score: 0,
      }),
    );

    const totalRow = selectAll<{ n: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM facts) + (SELECT COUNT(*) FROM constraints) AS n`,
    );

    return {
      query: queryText,
      facts,
      constraints,
      totalIndexed: totalRow[0]?.n ?? 0,
      searchedAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

function searchTable<T extends { score: number }>(
  db: any,
  queryVec: Float32Array,
  queryText: string,
  limit: number,
  table: string,
  ftsTable: string,
  mapRow: (row: any) => T,
): T[] {
  let ftsResults: Array<{ id: number; rank: number }> = [];
  try {
    ftsResults = selectAll<{ id: number; rank: number }>(
      db,
      `SELECT rowid AS id, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`,
      [queryText, FTS_CANDIDATES],
    );
  } catch {
    ftsResults = [];
  }

  const embeddingRows = selectAll<{ id: number; embedding: Uint8Array | null }>(
    db,
    `SELECT rowid AS id, embedding FROM ${table} WHERE embedding IS NOT NULL`,
  );
  const vecScores: Array<{ id: number; score: number }> = [];
  for (const row of embeddingRows) {
    if (!row.embedding) continue;
    const vec = blobToFloat(row.embedding);
    vecScores.push({ id: row.id, score: cosine(queryVec, vec) });
  }
  vecScores.sort((a, b) => b.score - a.score);
  const vecTop = vecScores.slice(0, VEC_CANDIDATES);

  const rrfScores = new Map<number, number>();
  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }
  for (let i = 0; i < vecTop.length; i++) {
    const id = vecTop[i].id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }

  const ranked = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const results: T[] = [];
  for (const [id, score] of ranked) {
    const rows = selectAll(db, `SELECT * FROM ${table} WHERE rowid = ?`, [id]);
    const row = rows[0];
    if (row) results.push({ ...mapRow(row), score });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Flattening + authority tiers
// ---------------------------------------------------------------------------

export function flattenFact(f: ExportFact): string {
  const parts: string[] = [];
  parts.push(`kind: ${f.kind}`);
  parts.push(
    `subject: ${f.subjectRef.refType} ${f.subjectRef.identityKind}=${f.subjectRef.identityValue}`,
  );
  parts.push(`scope: ${f.scope}`);
  const valStr = typeof f.value === "string"
    ? f.value
    : JSON.stringify(f.value ?? null);
  parts.push(`value: ${valStr}`);
  parts.push(`basis: ${f.authorityBasis}`);
  if (f.proposedBy) parts.push(`proposedBy: ${f.proposedBy}`);
  if (f.evidence && f.evidence.length > 0) {
    parts.push(`evidence: ${f.evidence.join(", ")}`);
  }
  return parts.join(" | ");
}

export function flattenConstraint(c: ExportConstraint): string {
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
// SQLite construction
// ---------------------------------------------------------------------------

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

const SQLITE_WASM_URL =
  "https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.53.0-build1.tgz";

let cachedWasmBytes: Uint8Array | null = null;
let cachedSqlite3: any | null = null;

async function loadSqlite3(logger: Logger): Promise<any> {
  if (cachedSqlite3) return cachedSqlite3;
  if (!cachedWasmBytes) {
    logger.info("loading sqlite3 wasm asset (first call this process)");
    cachedWasmBytes = await fetchSqliteWasm();
  }
  cachedSqlite3 =
    await (sqlite3InitModule as (config?: unknown) => Promise<any>)({
      wasmBinary: cachedWasmBytes,
    });
  return cachedSqlite3;
}

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

async function extractWasmFromTgz(tarGz: Uint8Array): Promise<Uint8Array> {
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
  let offset = 0;
  for (const c of chunks) {
    tar.set(c, offset);
    offset += c.byteLength;
  }
  const target = "package/dist/sqlite3.wasm";
  const decoder = new TextDecoder("utf-8");
  let pos = 0;
  while (pos + 512 <= tar.byteLength) {
    const header = tar.subarray(pos, pos + 512);
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(header.subarray(0, nameEnd));
    if (!name) break;
    const sizeStr = decoder
      .decode(header.subarray(124, 136))
      .replace(/[\0 ]+$/g, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const dataStart = pos + 512;
    if (name === target) {
      return tar.subarray(dataStart, dataStart + size).slice();
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`sqlite3.wasm not found in tarball (looked for "${target}")`);
}

async function buildSqlite(
  facts: ExportFact[],
  factTexts: string[],
  factEmbeddings: Float32Array[],
  constraints: ExportConstraint[],
  constraintTexts: string[],
  constraintEmbeddings: Float32Array[],
  embedUrl: string,
  embedModel: string,
  embedDim: number,
  logger: Logger,
): Promise<Uint8Array> {
  const sqlite3 = await loadSqlite3(logger);
  const db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    db.exec(SCHEMA_SQL);

    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
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

    for (let i = 0; i < constraints.length; i++) {
      const c = constraints[i];
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

    db.exec({
      sql: `INSERT INTO manifest (
              exported_at, embed_url, embed_model, embed_dim,
              fact_count, constraint_count, schema_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        new Date().toISOString(),
        embedUrl,
        embedModel,
        embedDim,
        facts.length,
        constraints.length,
        SCHEMA_VERSION,
      ],
    });

    return sqlite3.capi.sqlite3_js_db_export(db) as Uint8Array;
  } finally {
    db.close();
  }
}

async function openDbFromBytes(
  bytes: Uint8Array,
  logger: Logger,
): Promise<any> {
  const sqlite3 = await loadSqlite3(logger);
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB({ filename: ":memory:", flags: "c" });
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    "main",
    p,
    bytes.byteLength,
    bytes.byteLength,
    0x01 | 0x02, // SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc !== 0) {
    sqlite3.wasm.dealloc(p);
    throw new Error(`sqlite3_deserialize failed with rc=${rc}`);
  }
  return db;
}

function selectAll<T = Record<string, any>>(
  db: any,
  sql: string,
  bind: unknown[] = [],
): T[] {
  const rows: T[] = [];
  db.exec({
    sql,
    bind,
    rowMode: "object",
    callback: (row: T) => {
      rows.push(row);
    },
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

async function embedTexts(
  texts: string[],
  cfg: GlobalArgs,
  logger: Logger,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH_SIZE;
  const embedDim = cfg.embedDim ?? DEFAULT_EMBED_DIM;
  const embedModel = cfg.embedModel ?? DEFAULT_EMBED_MODEL;
  const url = joinUrl(cfg.embedUrl!, "embeddings");

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    logger.info("embedding batch {start}-{end} of {total}", {
      start: i,
      end: i + batch.length,
      total: texts.length,
    });
    const vecs = await embedOne(
      url,
      cfg.embedToken!,
      embedModel,
      embedDim,
      batch,
    );
    for (let j = 0; j < vecs.length; j++) {
      out[i + j] = vecs[j];
    }
  }
  return out;
}

async function embedOne(
  url: string,
  token: string,
  model: string,
  dim: number,
  batch: string[],
): Promise<Float32Array[]> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: batch }),
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
    if (vec.length !== dim) {
      throw new Error(
        `embedding dim mismatch: got ${vec.length}, expected ${dim}`,
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

export function floatToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

function blobToFloat(blob: Uint8Array | ArrayBuffer): Float32Array {
  const buf = blob instanceof Uint8Array ? blob.buffer : blob;
  const offset = blob instanceof Uint8Array ? blob.byteOffset : 0;
  const len = blob instanceof Uint8Array
    ? blob.byteLength
    : (blob as ArrayBuffer).byteLength;
  const copy = new ArrayBuffer(len);
  new Uint8Array(copy).set(new Uint8Array(buf, offset, len));
  return new Float32Array(copy);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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
