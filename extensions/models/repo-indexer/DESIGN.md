# @twonines/repo-indexer — Design

Replaces `@twonines/gitlab-repo-scanner`. Instead of pre-selecting "high-signal"
files and dumping their contents into a JSON artifact, this extension clones the
repo, chunks all text files, embeds them, and writes a SQLite database that
supports hybrid search (FTS5 keyword + vector cosine similarity).

Ferret queries the index with hypothesis-driven questions rather than reading
a curated file dump. The search queries — not a whitelist — determine what's
relevant.

## Methods

| Method    | Purpose |
|-----------|---------|
| `index`   | Clone repo to temp dir (shallow `--depth 1`), chunk all text files, embed all chunks, store file hashes, write SQLite db as data artifact. Deletes temp dir when done. |
| `search`  | Pull db artifact for a repo, embed the query, run hybrid search (FTS5 + vector + RRF rerank), return top-N chunks with metadata. |
| `reindex` | Pull existing db, shallow clone, `git diff` against stored commit SHA, re-chunk/re-embed only changed/added files, delete removed chunks, push updated db. |
| `status`  | Return index metadata: commit SHA, chunk count, embed model, last indexed time, db size. |

## Global Arguments

```
gitlabUrl:    GitLab instance base URL (e.g. https://git.bethelservice.org)
gitlabToken:  PAT with read_repository + read_api scope (vault this)
embedUrl:     OpenAI-compatible embeddings endpoint (e.g. https://aigw.bethelservice.org)
embedToken:   Bearer token for embedding API (vault this)
embedModel:   Model ID (default: text-embedding-3-small)
embedDim:     Vector dimension (default: 1536)
```

## SQLite Schema

One `.db` file per repo, stored as a binary data artifact in swamp's datastore.

```sql
CREATE TABLE chunks (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    content     TEXT NOT NULL,
    language    TEXT,
    chunk_type  TEXT NOT NULL
);

CREATE INDEX idx_chunks_path ON chunks(path);
CREATE INDEX idx_chunks_type ON chunks(chunk_type);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    content, path,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content, path)
    VALUES (new.id, new.content, new.path);
END;

CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
END;

CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
    INSERT INTO chunks_fts(rowid, content, path)
    VALUES (new.id, new.content, new.path);
END;

CREATE TABLE embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    vec      BLOB NOT NULL  -- 1536 × float32 = 6144 bytes per row
);

CREATE TABLE file_hashes (
    path    TEXT PRIMARY KEY,
    sha256  TEXT NOT NULL
);

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Keys: commit_sha, repo_path, indexed_at, embed_model, embed_dim, chunk_count
```

## Chunking Strategy

**What gets chunked:** Every text file in the repo.

**What gets excluded (not cloned/not chunked):**
- `.git/` (excluded by clone)
- `vendor/`, `node_modules/` (third-party code, not yours)
- Binary files (detected by file extension or null-byte presence in first 512 bytes)

**Chunk sizing:**
- Files < 2KB: whole file = one chunk
- Markdown (`.md`): split by h2 (`##`) headings; each section is a chunk. If no h2 headings, split by h1 or treat as single chunk.
- YAML/TOML/JSON config: split by top-level key. A `.gitlab-ci.yml` becomes one chunk per job definition.
- Code and everything else: fixed-size sliding window — 80 lines with 20-line overlap.

**Chunk metadata:**
- `path`: file path relative to repo root
- `start_line` / `end_line`: line range in original file
- `language`: detected from file extension
- `chunk_type`: one of `doc`, `config`, `code`, `ci`, `schema`, `data`, `other`

## Search: Hybrid with RRF Reranking

```
Input:
  query:      string    — natural language or keyword query
  repo:       string    — repo path (determines which db to pull)
  limit:      int       — max results (default 10)
  chunkTypes: string[]  — optional filter (e.g. ["doc", "config"])

Algorithm:
  1. Embed the query string → query vector
  2. FTS5 search: `chunks_fts MATCH query` → top 50 by BM25 rank
  3. Vector search: brute-force cosine(query_vec, chunk_vec) → top 50
  4. Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank_i(d)), k=60
  5. Apply chunkTypes filter if specified
  6. Return top-N results

Output per result:
  - path, start_line, end_line
  - content (the chunk text)
  - chunk_type, language
  - score (RRF combined score)
```

## Data Artifact Layout

- Resource spec: `index`
- Instance name: repo path with `/` → `--` (e.g. `o11n--eks`)
- Content type: `application/x-sqlite3`
- Lifetime: `infinite` (re-indexed on demand, not expiring)
- Garbage collection: 3 (keep last 3 versions for rollback)

## Embedding Approach

- Model: `text-embedding-3-small` (1536 dims) via OpenAI-compatible API
- Batch size: 100 chunks per API call (the endpoint supports batch input)
- Rate limiting: respect 429s with exponential backoff
- Cost: ~$0.02 per 1M tokens. A typical repo (500 chunks, avg 200 tokens/chunk) = 100K tokens = $0.002.

## Incremental Reindex

Uses file-hash comparison rather than git diff. This avoids needing git
history (shallow clones don't have it) and avoids persistent clone directories.

```
1. Pull existing db artifact
2. Clone repo to throwaway temp dir (--depth 1)
3. Hash every text file (SHA256 of content)
4. Compare to stored hashes in db (file_hashes table)
5. For files with changed/missing hash: delete old chunks, re-chunk, re-embed, insert
6. For files in db but absent from clone: delete their chunks
7. For new files (hash present in clone, absent in db): chunk, embed, insert
8. Update meta (commit_sha, indexed_at, chunk_count)
9. Push updated db as new artifact version
10. Delete temp dir
```

No persistent clone directory needed. The temp dir is created at
`/tmp/repo-indexer-<random>/` and removed after the method completes
(or on error).

## Runtime Dependencies

- SQLite: `npm:better-sqlite3` (synchronous, fast, WAL mode) — bundled by swamp
- Git: shell out to `git clone --depth 1` and `git diff` — requires git on the host
- Embedding API: fetch() to the OpenAI-compatible endpoint

## Relationship to Existing Components

- **Replaces:** `@twonines/gitlab-repo-scanner` scan + fetch_files methods
- **Preserves:** `discover` method moves here (find repos to index)
- **Consumed by:** propose-facts skill (ferret), review-proposals skill (mole)
- **Fact store:** unchanged — ferret still proposes facts the same way, just finds evidence via `search` instead of reading scan data dumps

## Open Questions

- **Chunking YAML by top-level key:** needs a lightweight YAML parser or regex splitter. Could use `npm:yaml` for structured parse, split at top-level mapping keys.
- **Markdown heading detection:** regex for `^##\s` is sufficient; no need for a full parser.
- **Binary detection:** extension-based allowlist of text extensions, plus null-byte check as fallback.
- **DB size upper bound:** The `o11n/eks` repo at ~5.3M largest file will produce many chunks. At 6KB per embedding + text content, estimate 50-100MB for the largest repos. Acceptable for S3 storage.
