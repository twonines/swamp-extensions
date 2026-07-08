/**
 * Shared SQLite WASM helper for swamp extensions.
 *
 * Provides a thin wrapper around @sqlite.org/sqlite-wasm's OO1 API that:
 *   - Fetches and caches the WASM binary from npm on first use
 *   - Creates in-memory databases (for building indexes)
 *   - Opens databases from existing bytes (for querying persisted artifacts)
 *   - Exports databases to Uint8Array (for persistence)
 *   - Provides a transaction() helper
 *
 * @module
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix

import sqlite3InitModule from "npm:@sqlite.org/sqlite-wasm@3.53.0-build1";

// ---------------------------------------------------------------------------
// WASM loading — fetch once, cache forever within the process
// ---------------------------------------------------------------------------

const SQLITE_WASM_URL =
  "https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.53.0-build1.tgz";

let cachedWasmBytes: Uint8Array | null = null;
let cachedSqlite3: any | null = null;

export interface Logger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Initialize the sqlite3 WASM module. Downloads the WASM binary on first
 * call (subsequent calls return the cached handle).
 */
export async function initSqlite3(logger?: Logger): Promise<any> {
  if (cachedSqlite3) return cachedSqlite3;
  if (!cachedWasmBytes) {
    logger?.info("loading sqlite3 wasm asset (first call this process)");
    cachedWasmBytes = await fetchSqliteWasm();
    logger?.info("sqlite3 wasm loaded: {bytes} bytes", {
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
 * Fetch and extract `dist/sqlite3.wasm` from the npm tarball.
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
    const blocks = Math.ceil(size / 512);
    pos = dataStart + blocks * 512;
  }
  throw new Error(`sqlite3.wasm not found in tarball (looked for "${target}")`);
}

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------

/**
 * A thin wrapper around the OO1 DB providing the subset of the
 * better-sqlite3 API that our extensions use.
 */
export class WasmDb {
  private db: any;
  private sqlite3: any;

  private constructor(db: any, sqlite3: any) {
    this.db = db;
    this.sqlite3 = sqlite3;
  }

  /** Create a new in-memory database. */
  static async create(logger?: Logger): Promise<WasmDb> {
    const sqlite3 = await initSqlite3(logger);
    const db = new sqlite3.oo1.DB(":memory:", "c");
    return new WasmDb(db, sqlite3);
  }

  /** Open a database from existing bytes (for read or read-write). */
  static async fromBytes(
    bytes: Uint8Array,
    logger?: Logger,
  ): Promise<WasmDb> {
    const sqlite3 = await initSqlite3(logger);
    // Deserialize: create an in-memory DB and import the bytes
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const db = new sqlite3.oo1.DB({
      filename: ":memory:",
      flags: "c",
    });
    // Use the deserialize API
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer,
      "main",
      p,
      bytes.byteLength,
      bytes.byteLength,
      // SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
      0x01 | 0x02,
    );
    if (rc !== 0) {
      sqlite3.wasm.dealloc(p);
      throw new Error(`sqlite3_deserialize failed with rc=${rc}`);
    }
    return new WasmDb(db, sqlite3);
  }

  /** Execute SQL with optional bindings. No result rows. */
  exec(sql: string, bind?: any[]): void {
    if (bind) {
      this.db.exec({ sql, bind });
    } else {
      this.db.exec(sql);
    }
  }

  /** Execute SQL and return all result rows as objects. */
  all<T = Record<string, any>>(sql: string, bind?: any[]): T[] {
    const rows: T[] = [];
    this.db.exec({
      sql,
      bind: bind ?? [],
      rowMode: "object",
      callback: (row: T) => {
        rows.push(row);
      },
    });
    return rows;
  }

  /** Execute SQL and return the first result row, or null. */
  get<T = Record<string, any>>(sql: string, bind?: any[]): T | null {
    const rows = this.all<T>(sql, bind);
    return rows[0] ?? null;
  }

  /** Execute multiple statements in a transaction. Rolls back on error. */
  transaction(fn: () => void): void {
    this.exec("BEGIN");
    try {
      fn();
      this.exec("COMMIT");
    } catch (e) {
      this.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Execute an INSERT and return the last inserted rowid.
   * (Useful for getting auto-increment IDs after insert.)
   */
  insert(sql: string, bind?: any[]): number {
    this.exec(sql, bind);
    const row = this.get<{ id: number }>(
      "SELECT last_insert_rowid() AS id",
    );
    return row?.id ?? 0;
  }

  /** Export the database to bytes. */
  export(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.db) as Uint8Array;
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Vector helpers (shared between extensions)
// ---------------------------------------------------------------------------

/** Encode a Float32Array as a Uint8Array for BLOB storage. */
export function floatToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Decode a BLOB (Uint8Array or ArrayBuffer) back to Float32Array. */
export function blobToFloat(blob: Uint8Array | ArrayBuffer): Float32Array {
  const buf = blob instanceof Uint8Array ? blob.buffer : blob;
  const offset = blob instanceof Uint8Array ? blob.byteOffset : 0;
  const len = blob instanceof Uint8Array
    ? blob.byteLength
    : (blob as ArrayBuffer).byteLength;
  // Copy to properly aligned buffer
  const copy = new ArrayBuffer(len);
  new Uint8Array(copy).set(new Uint8Array(buf, offset, len));
  return new Float32Array(copy);
}

/** Cosine similarity between two Float32Arrays. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
