/**
 * Clones a GitLab repository, chunks all text files, embeds them via an
 * OpenAI-compatible API, and writes a SQLite database supporting hybrid
 * search (FTS5 keyword + vector cosine with RRF reranking).
 *
 * Methods: index, search, reindex, status, discover.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { z } from "npm:zod@4";
import {
  blobToFloat,
  cosine,
  floatToBlob,
  WasmDb,
} from "../_lib/sqlite-wasm.ts";

type Ctx = any;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBED_BATCH_SIZE = 50;
const EMBED_MAX_RETRIES = 5;
/** Approximate character limit to stay under 8192 tokens. */
const EMBED_MAX_CHARS = 24000;
const CHUNK_LINES = 80;
const CHUNK_OVERLAP = 20;
const SMALL_FILE_BYTES = 2048;
const RRF_K = 60;
const DEFAULT_SEARCH_LIMIT = 10;
const FTS_CANDIDATES = 50;
const VEC_CANDIDATES = 50;

/** Directories excluded from indexing. */
const EXCLUDED_DIRS = new Set([
  "vendor",
  "node_modules",
  ".git",
]);

/** Extensions treated as binary (never chunked). */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".flac",
  ".avi",
  ".mov",
  ".mkv",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".pyc",
  ".class",
  ".wasm",
  ".sqlite",
  ".db",
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  gitlabUrl: z.string().url().describe(
    "GitLab instance base URL (e.g. https://gitlab.example.com)",
  ),
  gitlabToken: z.string().meta({ sensitive: true }).describe(
    "Personal access token with read_repository + read_api scope.",
  ),
  embedUrl: z.string().url().describe(
    "OpenAI-compatible embeddings endpoint base URL.",
  ),
  embedToken: z.string().meta({ sensitive: true }).describe(
    "Bearer token for the embeddings API.",
  ),
  embedModel: z.string().optional().describe(
    "Embedding model ID (default: text-embedding-3-small).",
  ),
  embedDim: z.number().optional().describe(
    "Vector dimension (default: 1536).",
  ),
  excludePatterns: z.array(z.string()).optional().describe(
    "Glob patterns for files to exclude from indexing (e.g. ['*-lock.*', '*.lock', 'static/data/**']).",
  ),
});

const SearchResultSchema = z.object({
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  content: z.string(),
  chunkType: z.string(),
  language: z.string().nullable(),
  score: z.number(),
});

const SearchOutputSchema = z.object({
  repo: z.string(),
  query: z.string(),
  results: z.array(SearchResultSchema),
  totalChunks: z.number(),
  searchedAt: z.string(),
});

const StatusOutputSchema = z.object({
  repo: z.string(),
  commitSha: z.string(),
  chunkCount: z.number(),
  embedModel: z.string(),
  embedDim: z.number(),
  indexedAt: z.string(),
  dbSizeBytes: z.number(),
});

const IndexOutputSchema = z.object({
  repo: z.string(),
  commitSha: z.string(),
  chunkCount: z.number(),
  filesIndexed: z.number(),
  indexedAt: z.string(),
});

const DiscoveredRepoSchema = z.object({
  path: z.string(),
  lastActivityAt: z.string(),
  visibility: z.string(),
});

const DiscoverOutputSchema = z.object({
  repos: z.array(DiscoveredRepoSchema),
  totalFound: z.number(),
  filters: z.object({
    groups: z.array(z.string()).optional(),
    activeSince: z.string().optional(),
    archived: z.boolean(),
  }),
  discoveredAt: z.string(),
});

// ---------------------------------------------------------------------------
// SQLite Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    content     TEXT NOT NULL,
    language    TEXT,
    chunk_type  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content, path,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content, path)
    VALUES (new.id, new.content, new.path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
    INSERT INTO chunks_fts(rowid, content, path)
    VALUES (new.id, new.content, new.path);
END;

CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    vec      BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS file_hashes (
    path    TEXT PRIMARY KEY,
    sha256  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Helpers: shell, filesystem, hashing
// ---------------------------------------------------------------------------

/** Run a shell command synchronously; throw on non-zero exit. */
function exec(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const result = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(
      `Command failed: ${cmd.join(" ")}\n${stderr.slice(0, 500)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** SHA256 hash of a string, returned as hex. */
async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Detect if a file path is binary by extension. */
function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Check if content looks binary (null bytes in first 512 bytes). */
function isBinaryContent(content: Uint8Array): boolean {
  const check = content.slice(0, 512);
  for (const byte of check) {
    if (byte === 0) return true;
  }
  return false;
}

/** Detect language from file extension. */
function detectLanguage(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    tsx: "typescript",
    jsx: "javascript",
    go: "go",
    rs: "rust",
    py: "python",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    graphql: "graphql",
    proto: "protobuf",
    tf: "terraform",
    hcl: "hcl",
    md: "markdown",
    dockerfile: "dockerfile",
    makefile: "makefile",
    jsonnet: "jsonnet",
    libsonnet: "jsonnet",
    tmpl: "template",
    tpl: "template",
  };
  // Handle extensionless files by name
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return map[ext] ?? null;
}

/** Detect chunk_type from file path and language. */
function detectChunkType(path: string, language: string | null): string {
  if (path.includes(".gitlab-ci") || path.includes("ci/")) return "ci";
  if (language === "markdown") return "doc";
  if (language === "sql" || path.includes("migration")) return "schema";
  if (
    language === "yaml" || language === "toml" || language === "json" ||
    language === "hcl" || language === "terraform"
  ) {
    return "config";
  }
  if (language === "graphql" || language === "protobuf") return "schema";
  if (path.endsWith(".graphql") || path.endsWith(".proto")) return "schema";
  if (language) return "code";
  return "other";
}

/**
 * Match a path against a glob pattern. Supports:
 *   - `*` matches any characters except `/`
 *   - `**` matches any characters including `/`
 *   - `?` matches a single character except `/`
 */
function globMatch(pattern: string, path: string): boolean {
  // Convert glob to regex
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // consume trailing slash after **
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(pattern[i])) {
      regex += "\\" + pattern[i];
      i++;
    } else {
      regex += pattern[i];
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex).test(path);
}

/** Check if a path matches any of the exclude patterns. */
function isExcluded(path: string, patterns: string[]): boolean {
  const name = path.split("/").pop() ?? "";
  for (const p of patterns) {
    // Match against full relative path and against just the filename
    if (globMatch(p, path) || globMatch(p, name)) return true;
  }
  return false;
}

/** Walk a directory recursively, yielding relative paths of text files. */
function walkTextFiles(root: string, excludePatterns?: string[]): string[] {
  const files: string[] = [];
  const patterns = excludePatterns ?? [];
  function walk(dir: string, rel: string) {
    for (const entry of Deno.readDirSync(dir)) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        if (patterns.length > 0 && isExcluded(entryRel + "/", patterns)) {
          continue;
        }
        walk(`${dir}/${entry.name}`, entryRel);
      } else if (entry.isFile) {
        if (isBinaryPath(entryRel)) continue;
        if (patterns.length > 0 && isExcluded(entryRel, patterns)) continue;
        files.push(entryRel);
      }
    }
  }
  walk(root, "");
  return files;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string | null;
  chunkType: string;
}

/** Split a file into chunks based on its type. */
function chunkFile(path: string, content: string): Chunk[] {
  const language = detectLanguage(path);
  const chunkType = detectChunkType(path, language);
  const lines = content.split("\n");

  // Small files: single chunk
  if (content.length <= SMALL_FILE_BYTES) {
    return [{
      path,
      startLine: 1,
      endLine: lines.length,
      content,
      language,
      chunkType,
    }];
  }

  // Markdown: split by h2 headings
  if (language === "markdown") {
    return chunkMarkdown(path, lines, language, chunkType);
  }

  // YAML: split by top-level keys
  if (language === "yaml" && chunkType === "config") {
    return chunkYaml(path, lines, language, chunkType);
  }

  // Everything else: fixed-size sliding window
  return chunkSlidingWindow(path, lines, language, chunkType);
}

/** Split markdown by h2 (##) headings. */
function chunkMarkdown(
  path: string,
  lines: string[],
  language: string | null,
  chunkType: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let sectionStart = 0;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (i > sectionStart) {
        chunks.push({
          path,
          startLine: sectionStart + 1,
          endLine: i,
          content: lines.slice(sectionStart, i).join("\n"),
          language,
          chunkType,
        });
      }
      sectionStart = i;
    }
  }
  // Final section
  if (sectionStart < lines.length) {
    chunks.push({
      path,
      startLine: sectionStart + 1,
      endLine: lines.length,
      content: lines.slice(sectionStart).join("\n"),
      language,
      chunkType,
    });
  }
  return chunks.length > 0 ? chunks : [{
    path,
    startLine: 1,
    endLine: lines.length,
    content: lines.join("\n"),
    language,
    chunkType,
  }];
}

/** Split YAML by top-level keys (lines that start with a non-space character). */
function chunkYaml(
  path: string,
  lines: string[],
  language: string | null,
  chunkType: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let sectionStart = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // A top-level key: starts with a non-space, non-comment, non-empty char
    if (
      line.length > 0 &&
      line[0] !== " " &&
      line[0] !== "\t" &&
      line[0] !== "#" &&
      line[0] !== "-"
    ) {
      if (i > sectionStart) {
        chunks.push({
          path,
          startLine: sectionStart + 1,
          endLine: i,
          content: lines.slice(sectionStart, i).join("\n"),
          language,
          chunkType,
        });
      }
      sectionStart = i;
    }
  }
  if (sectionStart < lines.length) {
    chunks.push({
      path,
      startLine: sectionStart + 1,
      endLine: lines.length,
      content: lines.slice(sectionStart).join("\n"),
      language,
      chunkType,
    });
  }
  return chunks.length > 0 ? chunks : [{
    path,
    startLine: 1,
    endLine: lines.length,
    content: lines.join("\n"),
    language,
    chunkType,
  }];
}

/** Fixed-size sliding window chunking. */
function chunkSlidingWindow(
  path: string,
  lines: string[],
  language: string | null,
  chunkType: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    chunks.push({
      path,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join("\n"),
      language,
      chunkType,
    });
    if (end >= lines.length) break;
    start += CHUNK_LINES - CHUNK_OVERLAP;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding Client
// ---------------------------------------------------------------------------

interface EmbedConfig {
  url: string;
  token: string;
  model: string;
  dim: number;
}

/** Embed a batch of texts. Returns float32 arrays in input order. */
async function embedBatch(
  config: EmbedConfig,
  texts: string[],
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const body = JSON.stringify({ model: config.model, input: texts });
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < EMBED_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }

    const resp = await fetch(`${config.url}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (!isNaN(secs) && secs > 0) {
          await new Promise((r) => setTimeout(r, secs * 1000));
        }
      }
      lastErr = new Error(`Rate limited (429) on attempt ${attempt + 1}`);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Embedding API error ${resp.status}: ${text.slice(0, 200)}`,
      );
    }

    const json = await resp.json() as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    if (json.data.length !== texts.length) {
      throw new Error(
        `Expected ${texts.length} embeddings, got ${json.data.length}`,
      );
    }

    // Sort by index to guarantee order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }

  throw lastErr ?? new Error("Embedding failed after retries");
}

/** Embed all chunks in batches, returning vectors in order. */
async function embedAllChunks(
  config: EmbedConfig,
  chunks: Chunk[],
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) =>
      c.content.length > EMBED_MAX_CHARS
        ? c.content.slice(0, EMBED_MAX_CHARS)
        : c.content
    );
    const vecs = await embedBatch(config, texts);
    vectors.push(...vecs);
    // Small delay between batches to respect rate limits
    if (i + EMBED_BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return vectors;
}

/** Encode a Float32Array as a Uint8Array for SQLite BLOB storage. */
// Using floatToBlob from shared _lib/sqlite-wasm.ts

/** Decode a BLOB back to Float32Array. */
// Using blobToFloat from shared _lib/sqlite-wasm.ts

/** Cosine similarity between two vectors. */
// Using cosine from shared _lib/sqlite-wasm.ts

// ---------------------------------------------------------------------------
// SQLite Operations
// ---------------------------------------------------------------------------

/** Create a new in-memory database with the schema. */
async function createDb(
  logger?: { info: (m: string, f?: Record<string, unknown>) => void },
): Promise<WasmDb> {
  const db = await WasmDb.create(logger);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Open a database from bytes (for search/status). */
async function openDb(
  bytes: Uint8Array,
  logger?: { info: (m: string, f?: Record<string, unknown>) => void },
): Promise<WasmDb> {
  return await WasmDb.fromBytes(bytes, logger);
}

/** Insert chunks and their embeddings into the database. */
function insertChunks(
  db: WasmDb,
  chunks: Chunk[],
  vectors: Float32Array[],
  fileHashes: Map<string, string>,
): void {
  db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const rowid = db.insert(
        `INSERT INTO chunks (path, start_line, end_line, content, language, chunk_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c.path, c.startLine, c.endLine, c.content, c.language, c.chunkType],
      );
      db.exec(
        `INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?)`,
        [rowid, floatToBlob(vectors[i])],
      );
    }
    for (const [path, hash] of fileHashes) {
      db.exec(
        `INSERT OR REPLACE INTO file_hashes (path, sha256) VALUES (?, ?)`,
        [path, hash],
      );
    }
  });
}

/** Delete all chunks (and cascading embeddings) for given file paths. */
function deleteChunksForPaths(db: WasmDb, paths: string[]): void {
  db.transaction(() => {
    for (const p of paths) {
      db.exec(`DELETE FROM chunks WHERE path = ?`, [p]);
      db.exec(`DELETE FROM file_hashes WHERE path = ?`, [p]);
    }
  });
}

/** Set a meta key. */
function setMeta(db: WasmDb, key: string, value: string): void {
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [
    key,
    value,
  ]);
}

/** Get a meta value or null. */
function getMeta(db: WasmDb, key: string): string | null {
  const row = db.get<{ value: string }>(
    `SELECT value FROM meta WHERE key = ?`,
    [key],
  );
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Hybrid Search (FTS5 + Vector + RRF)
// ---------------------------------------------------------------------------

interface SearchHit {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  chunkType: string;
  language: string | null;
  score: number;
}

/** Run hybrid search: FTS5 + vector cosine → RRF fusion. */
function hybridSearch(
  db: WasmDb,
  queryVec: Float32Array,
  queryText: string,
  limit: number,
  chunkTypes?: string[],
): SearchHit[] {
  // --- FTS5 search ---
  let ftsResults: Array<{ id: number; rank: number }> = [];
  try {
    const ftsQuery = chunkTypes && chunkTypes.length > 0
      ? `SELECT c.id, f.rank FROM chunks_fts f
         JOIN chunks c ON c.id = f.rowid
         WHERE chunks_fts MATCH ? AND c.chunk_type IN (${
        chunkTypes.map(() => "?").join(",")
      })
         ORDER BY f.rank LIMIT ?`
      : `SELECT c.id, f.rank FROM chunks_fts f
         JOIN chunks c ON c.id = f.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY f.rank LIMIT ?`;

    const ftsParams = chunkTypes && chunkTypes.length > 0
      ? [queryText, ...chunkTypes, FTS_CANDIDATES]
      : [queryText, FTS_CANDIDATES];

    ftsResults = db.all<{ id: number; rank: number }>(ftsQuery, ftsParams);
  } catch {
    // FTS5 MATCH can throw on invalid query syntax; fall back to vector-only
    ftsResults = [];
  }

  // --- Vector search (brute force) ---
  const vecQuery = chunkTypes && chunkTypes.length > 0
    ? `SELECT e.chunk_id, e.vec FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       WHERE c.chunk_type IN (${chunkTypes.map(() => "?").join(",")})`
    : `SELECT chunk_id, vec FROM embeddings`;
  const vecParams = chunkTypes && chunkTypes.length > 0 ? chunkTypes : [];
  const allEmbeddings = db.all<{ chunk_id: number; vec: Uint8Array }>(
    vecQuery,
    vecParams,
  );

  const vecScores: Array<{ id: number; score: number }> = [];
  for (const row of allEmbeddings) {
    const vec = blobToFloat(row.vec);
    const score = cosine(queryVec, vec);
    vecScores.push({ id: row.chunk_id, score });
  }
  vecScores.sort((a, b) => b.score - a.score);
  const vecTop = vecScores.slice(0, VEC_CANDIDATES);

  // --- RRF fusion ---
  const rrfScores = new Map<number, number>();

  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }
  for (let i = 0; i < vecTop.length; i++) {
    const id = vecTop[i].id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }

  // Sort by RRF score descending
  const ranked = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  // Fetch full chunk data for top results
  const results: SearchHit[] = [];
  for (const [id, score] of ranked) {
    const row = db.get<{
      id: number;
      path: string;
      start_line: number;
      end_line: number;
      content: string;
      chunk_type: string;
      language: string | null;
    }>(
      `SELECT id, path, start_line, end_line, content, chunk_type, language
        FROM chunks WHERE id = ?`,
      [id],
    );
    if (row) {
      results.push({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        chunkType: row.chunk_type,
        language: row.language,
        score,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Model definition for `@twonines/repo-indexer`. Clones GitLab repositories,
 * chunks all text files, embeds them via an OpenAI-compatible API, and
 * writes a SQLite database supporting hybrid search (FTS5 + vector cosine
 * with RRF reranking). Methods: index, search, reindex, status, discover.
 */
export const model = {
  type: "@twonines/repo-indexer",
  version: "2026.07.07.1",
  description:
    "Clones a GitLab repository, chunks all text files, embeds them, and writes " +
    "a SQLite database supporting hybrid search (FTS5 + vector cosine + RRF). " +
    "Use search to query the index with natural language or keywords.",
  globalArguments: GlobalArgsSchema,
  resources: {
    index: {
      description: "SQLite index database for a repository",
      schema: IndexOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    search: {
      description: "Search results from a hybrid query",
      schema: SearchOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    status: {
      description: "Index metadata for a repository",
      schema: StatusOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    discovery: {
      description: "List of discovered repos matching filters",
      schema: DiscoverOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    index: {
      description:
        "Clone a repository, chunk all text files, embed them, and write " +
        "a SQLite database as a data artifact. Subsequent calls overwrite " +
        "the previous index for the same repo.",
      arguments: z.object({
        projectPath: z.string().describe(
          "Repository path (e.g. mygroup/myrepo)",
        ),
      }),
      execute: async (
        args: { projectPath: string },
        context: Ctx,
      ) => {
        const g = context.globalArgs as z.infer<typeof GlobalArgsSchema>;
        const embedConfig: EmbedConfig = {
          url: g.embedUrl,
          token: g.embedToken,
          model: g.embedModel ?? "text-embedding-3-small",
          dim: g.embedDim ?? 1536,
        };
        const projectPath = args.projectPath;
        const instanceName = projectPath.replaceAll("/", "--");

        context.logger.info("Indexing repository {path}", {
          path: projectPath,
        });

        // Clone to temp dir
        const tmpDir = Deno.makeTempDirSync({ prefix: "repo-indexer-" });
        try {
          const cloneUrl = `${g.gitlabUrl}/${projectPath}.git`;
          exec(["git", "clone", "--depth", "1", cloneUrl, tmpDir], {
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "echo",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraHeader",
              GIT_CONFIG_VALUE_0: `PRIVATE-TOKEN: ${g.gitlabToken}`,
            },
          });

          // Get commit SHA
          const commitSha = exec(["git", "rev-parse", "HEAD"], { cwd: tmpDir })
            .trim();

          // Walk and read files
          const filePaths = walkTextFiles(tmpDir, g.excludePatterns);
          context.logger.info("Found {count} text files", {
            count: filePaths.length,
          });

          const allChunks: Chunk[] = [];
          const fileHashes = new Map<string, string>();

          for (const relPath of filePaths) {
            const fullPath = `${tmpDir}/${relPath}`;
            const raw = Deno.readFileSync(fullPath);
            if (isBinaryContent(raw)) continue;
            const content = new TextDecoder().decode(raw);
            const hash = await sha256(content);
            fileHashes.set(relPath, hash);
            const chunks = chunkFile(relPath, content);
            allChunks.push(...chunks);
          }

          // Filter out empty/whitespace-only chunks that would fail embedding
          const validChunks = allChunks.filter(
            (c) => c.content.trim().length > 0,
          );

          context.logger.info("Chunked into {count} chunks, embedding...", {
            count: validChunks.length,
          });

          // Embed all chunks
          const vectors = await embedAllChunks(embedConfig, validChunks);

          // Write SQLite db (in-memory via WASM, then export bytes)
          const db = await createDb(context.logger);
          try {
            insertChunks(db, validChunks, vectors, fileHashes);
            setMeta(db, "commit_sha", commitSha);
            setMeta(db, "repo_path", projectPath);
            setMeta(db, "indexed_at", new Date().toISOString());
            setMeta(db, "embed_model", embedConfig.model);
            setMeta(db, "embed_dim", String(embedConfig.dim));
            setMeta(db, "chunk_count", String(validChunks.length));
          } catch (e) {
            db.close();
            throw e;
          }
          const dbBytes = db.export();
          db.close();

          // Write to local index directory
          const indexDir = `${Deno.env.get("HOME") ?? "/tmp"}/.repo-indexes`;
          try {
            Deno.mkdirSync(indexDir, { recursive: true });
          } catch { /* exists */ }
          const dbPath = `${indexDir}/${instanceName}.db`;
          Deno.writeFileSync(dbPath, dbBytes);

          // Persist metadata as data artifact
          const handle = await context.writeResource(
            "index",
            instanceName,
            {
              repo: projectPath,
              commitSha,
              chunkCount: validChunks.length,
              filesIndexed: fileHashes.size,
              indexedAt: new Date().toISOString(),
              dbPath,
              dbSizeBytes: dbBytes.byteLength,
            },
          );

          context.logger.info(
            "Index complete: {chunks} chunks from {files} files",
            { chunks: validChunks.length, files: fileHashes.size },
          );

          return { dataHandles: [handle] };
        } finally {
          // Clean up temp dir
          try {
            Deno.removeSync(tmpDir, { recursive: true });
          } catch { /* best-effort cleanup */ }
        }
      },
    },

    search: {
      description:
        "Search a repository's index with hybrid FTS5 + vector search. " +
        "Returns ranked chunks with file paths, line ranges, and content.",
      arguments: z.object({
        repo: z.string().describe("Repository path (e.g. mygroup/myrepo)"),
        query: z.string().describe(
          "Search query — natural language or keywords",
        ),
        limit: z.number().optional().describe(
          "Max results to return (default: 10)",
        ),
        chunkTypes: z.array(z.string()).optional().describe(
          "Filter by chunk type: doc, config, code, ci, schema, other",
        ),
      }),
      execute: async (
        args: {
          repo: string;
          query: string;
          limit?: number;
          chunkTypes?: string[];
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs as z.infer<typeof GlobalArgsSchema>;
        const embedConfig: EmbedConfig = {
          url: g.embedUrl,
          token: g.embedToken,
          model: g.embedModel ?? "text-embedding-3-small",
          dim: g.embedDim ?? 1536,
        };
        const instanceName = args.repo.replaceAll("/", "--");
        const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;

        context.logger.info("Searching {repo} for: {query}", {
          repo: args.repo,
          query: args.query,
        });

        // Read index DB from local file
        const indexDir = `${Deno.env.get("HOME") ?? "/tmp"}/.repo-indexes`;
        const localDbPath = `${indexDir}/${instanceName}.db`;
        try {
          Deno.statSync(localDbPath);
        } catch {
          throw new Error(
            `No index found for ${args.repo} at ${localDbPath}. Run the index method first.`,
          );
        }

        const dbBytes = Deno.readFileSync(localDbPath);
        const db = await openDb(dbBytes, context.logger);
        try {
          // Embed the query
          const [queryVec] = await embedBatch(embedConfig, [args.query]);

          // Run hybrid search
          const hits = hybridSearch(
            db,
            queryVec,
            args.query,
            limit,
            args.chunkTypes,
          );

          const row = db.get<{ n: number }>("SELECT COUNT(*) as n FROM chunks");
          const totalChunks = row?.n ?? 0;

          const output = {
            repo: args.repo,
            query: args.query,
            results: hits.map((h) => ({
              path: h.path,
              startLine: h.startLine,
              endLine: h.endLine,
              content: h.content,
              chunkType: h.chunkType,
              language: h.language,
              score: h.score,
            })),
            totalChunks,
            searchedAt: new Date().toISOString(),
          };

          const handle = await context.writeResource(
            "search",
            `${instanceName}--${Date.now()}`,
            output,
          );

          return { dataHandles: [handle] };
        } finally {
          db.close();
        }
      },
    },

    reindex: {
      description:
        "Incrementally reindex a repository. Compares file hashes to detect " +
        "changes, only re-chunks and re-embeds modified/added files.",
      arguments: z.object({
        projectPath: z.string().describe(
          "Repository path (e.g. mygroup/myrepo)",
        ),
      }),
      execute: async (
        args: { projectPath: string },
        context: Ctx,
      ) => {
        const g = context.globalArgs as z.infer<typeof GlobalArgsSchema>;
        const embedConfig: EmbedConfig = {
          url: g.embedUrl,
          token: g.embedToken,
          model: g.embedModel ?? "text-embedding-3-small",
          dim: g.embedDim ?? 1536,
        };
        const projectPath = args.projectPath;
        const instanceName = projectPath.replaceAll("/", "--");

        context.logger.info("Reindexing repository {path}", {
          path: projectPath,
        });

        // Check for existing local index
        const indexDir = `${Deno.env.get("HOME") ?? "/tmp"}/.repo-indexes`;
        const existingDbPath = `${indexDir}/${instanceName}.db`;
        let hasExisting = false;
        try {
          Deno.statSync(existingDbPath);
          hasExisting = true;
        } catch { /* no existing */ }
        if (!hasExisting) {
          context.logger.info(
            "No existing index — falling back to full index",
          );
          // Delegate to full index
          return await model.methods.index.execute(args, context);
        }

        // Clone to temp dir
        const tmpDir = Deno.makeTempDirSync({ prefix: "repo-indexer-" });
        try {
          const cloneUrl = `${g.gitlabUrl}/${projectPath}.git`;
          exec(["git", "clone", "--depth", "1", cloneUrl, `${tmpDir}/repo`], {
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "echo",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraHeader",
              GIT_CONFIG_VALUE_0: `PRIVATE-TOKEN: ${g.gitlabToken}`,
            },
          });
          const repoDir = `${tmpDir}/repo`;
          const commitSha = exec(["git", "rev-parse", "HEAD"], {
            cwd: repoDir,
          }).trim();

          // Load existing db into WASM from the file
          const existingBytes = Deno.readFileSync(existingDbPath);
          const db = await openDb(existingBytes, context.logger);

          try {
            // Load existing file hashes
            const existingHashes = new Map<string, string>();
            const rows = db.all<{ path: string; sha256: string }>(
              "SELECT path, sha256 FROM file_hashes",
            );
            for (const row of rows) {
              existingHashes.set(row.path, row.sha256);
            }

            // Walk current files and hash them
            const currentFiles = walkTextFiles(repoDir, g.excludePatterns);
            const currentHashes = new Map<string, string>();
            const fileContents = new Map<string, string>();

            for (const relPath of currentFiles) {
              const fullPath = `${repoDir}/${relPath}`;
              const raw = Deno.readFileSync(fullPath);
              if (isBinaryContent(raw)) continue;
              const content = new TextDecoder().decode(raw);
              const hash = await sha256(content);
              currentHashes.set(relPath, hash);
              fileContents.set(relPath, content);
            }

            // Determine changes
            const toDelete: string[] = [];
            const toAdd: string[] = [];

            // Files removed or changed
            for (const [path, hash] of existingHashes) {
              if (!currentHashes.has(path)) {
                toDelete.push(path);
              } else if (currentHashes.get(path) !== hash) {
                toDelete.push(path);
                toAdd.push(path);
              }
            }
            // New files
            for (const path of currentHashes.keys()) {
              if (!existingHashes.has(path)) {
                toAdd.push(path);
              }
            }

            context.logger.info(
              "Reindex: {del} deleted, {add} added/modified, {unchanged} unchanged",
              {
                del: toDelete.length,
                add: toAdd.length,
                unchanged: currentHashes.size - toAdd.length,
              },
            );

            // Delete old chunks
            if (toDelete.length > 0) {
              deleteChunksForPaths(db, toDelete);
            }

            // Chunk and embed new/modified files
            if (toAdd.length > 0) {
              const newChunks: Chunk[] = [];
              const newHashes = new Map<string, string>();
              for (const path of toAdd) {
                const content = fileContents.get(path)!;
                newHashes.set(path, currentHashes.get(path)!);
                newChunks.push(...chunkFile(path, content));
              }

              const validNewChunks = newChunks.filter(
                (c) => c.content.trim().length > 0,
              );
              const vectors = await embedAllChunks(embedConfig, validNewChunks);
              insertChunks(db, validNewChunks, vectors, newHashes);
            }

            // Update meta
            const countRow = db.get<{ n: number }>(
              "SELECT COUNT(*) as n FROM chunks",
            );
            const totalChunks = countRow?.n ?? 0;
            setMeta(db, "commit_sha", commitSha);
            setMeta(db, "indexed_at", new Date().toISOString());
            setMeta(db, "chunk_count", String(totalChunks));

            // Export and close
            const dbBytes = db.export();
            db.close();

            // Write updated db to local file
            Deno.writeFileSync(existingDbPath, dbBytes);

            // Persist metadata
            const handle = await context.writeResource(
              "index",
              instanceName,
              {
                repo: projectPath,
                commitSha,
                chunkCount: totalChunks,
                filesIndexed: currentHashes.size,
                indexedAt: new Date().toISOString(),
                dbPath: existingDbPath,
                dbSizeBytes: dbBytes.byteLength,
              },
            );

            context.logger.info("Reindex complete: {chunks} total chunks", {
              chunks: totalChunks,
            });

            return { dataHandles: [handle] };
          } catch (err) {
            db.close();
            throw err;
          }
        } finally {
          try {
            Deno.removeSync(tmpDir, { recursive: true });
          } catch { /* best-effort cleanup */ }
        }
      },
    },

    status: {
      description:
        "Return index metadata for a repository: commit SHA, chunk count, " +
        "embedding model, last indexed time, and database size.",
      arguments: z.object({
        repo: z.string().describe("Repository path (e.g. mygroup/myrepo)"),
      }),
      execute: async (
        args: { repo: string },
        context: Ctx,
      ) => {
        const instanceName = args.repo.replaceAll("/", "--");

        const indexDir = `${Deno.env.get("HOME") ?? "/tmp"}/.repo-indexes`;
        const dbPath = `${indexDir}/${instanceName}.db`;
        try {
          Deno.statSync(dbPath);
        } catch {
          throw new Error(
            `No index found for ${args.repo} at ${dbPath}. Run the index method first.`,
          );
        }

        const stat = Deno.statSync(dbPath);
        const dbFileBytes = Deno.readFileSync(dbPath);
        const db = await openDb(dbFileBytes, context.logger);
        try {
          const output = {
            repo: args.repo,
            commitSha: getMeta(db, "commit_sha") ?? "unknown",
            chunkCount: Number(getMeta(db, "chunk_count") ?? "0"),
            embedModel: getMeta(db, "embed_model") ?? "unknown",
            embedDim: Number(getMeta(db, "embed_dim") ?? "0"),
            indexedAt: getMeta(db, "indexed_at") ?? "unknown",
            dbSizeBytes: stat.size,
          };

          const handle = await context.writeResource(
            "status",
            instanceName,
            output,
          );
          return { dataHandles: [handle] };
        } finally {
          db.close();
        }
      },
    },

    discover: {
      description:
        "Discover active repositories from the GitLab instance. Returns " +
        "paths suitable as input to the index method.",
      arguments: z.object({
        groups: z.array(z.string()).optional().describe(
          "Limit to these group paths (e.g. ['engineering', 'platform'])",
        ),
        activeSince: z.string().optional().describe(
          "ISO date — only repos with activity after this date (default: 90 days ago)",
        ),
        perPage: z.number().optional().describe(
          "Results per page (default: 100, max: 100)",
        ),
        maxPages: z.number().optional().describe(
          "Max pages to fetch (default: 10)",
        ),
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
        const g = context.globalArgs as z.infer<typeof GlobalArgsSchema>;
        const perPage = Math.min(args.perPage ?? 100, 100);
        const maxPages = args.maxPages ?? 10;
        const since = args.activeSince ??
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
            .split("T")[0];

        context.logger.info("Discovering repos active since {since}", {
          since,
        });

        const headers = { "PRIVATE-TOKEN": g.gitlabToken };
        const repos: Array<
          { path: string; lastActivityAt: string; visibility: string }
        > = [];

        if (args.groups && args.groups.length > 0) {
          for (const group of args.groups) {
            const groupId = encodeURIComponent(group);
            for (let page = 1; page <= maxPages; page++) {
              const url =
                `${g.gitlabUrl}/api/v4/groups/${groupId}/projects?include_subgroups=true&archived=false` +
                `&last_activity_after=${since}&per_page=${perPage}&page=${page}` +
                `&order_by=last_activity_at&sort=desc`;
              const resp = await fetch(url, { headers });
              if (!resp.ok) throw new Error(`GitLab API ${resp.status}`);
              const projects = await resp.json() as Array<
                Record<string, unknown>
              >;
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
            const url =
              `${g.gitlabUrl}/api/v4/projects?archived=false&last_activity_after=${since}` +
              `&per_page=${perPage}&page=${page}&order_by=last_activity_at&sort=desc`;
            const resp = await fetch(url, { headers });
            if (!resp.ok) throw new Error(`GitLab API ${resp.status}`);
            const projects = await resp.json() as Array<
              Record<string, unknown>
            >;
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

        const output = {
          repos,
          totalFound: repos.length,
          filters: {
            groups: args.groups,
            activeSince: since,
            archived: false,
          },
          discoveredAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "discovery",
          "snapshot",
          output,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
