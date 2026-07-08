# @twonines/repo-indexer

Clones a GitLab repository, chunks all text files, embeds them via an
OpenAI-compatible API (text-embedding-3-small by default), and writes a
SQLite database that supports hybrid search — FTS5 keyword matching plus
vector cosine similarity, fused with Reciprocal Rank Fusion.

Designed for the ferret/mole fact-discovery pipeline: ferret queries the
index with hypothesis-driven questions, gets ranked evidence chunks, and
proposes facts to the fact-store.

## Usage

```bash
# Create a model instance
swamp model create repo-indexer --type @twonines/repo-indexer \
  --global-arg gitlabUrl=https://gitlab.example.com \
  --global-arg gitlabToken=vault.get("gitlab","token") \
  --global-arg embedUrl=https://embeddings.example.com \
  --global-arg embedToken=vault.get("embed","token")

# Index a repository
swamp model method run repo-indexer index \
  --input projectPath=mygroup/myrepo

# Search the index
swamp model method run repo-indexer search \
  --input repo=mygroup/myrepo \
  --input query="what external services does this integrate with"

# Incremental reindex (only re-embeds changed files)
swamp model method run repo-indexer reindex \
  --input projectPath=mygroup/myrepo

# Check index status
swamp model method run repo-indexer status \
  --input repo=mygroup/myrepo
```

## Methods

| Method    | Description |
|-----------|-------------|
| `index`   | Clone, chunk, embed, write SQLite db as data artifact |
| `search`  | Hybrid FTS5 + vector search with RRF reranking |
| `reindex` | Incremental update — only re-processes changed files |
| `status`  | Index metadata: commit SHA, chunk count, model, last indexed |
| `discover`| Find active repos on the GitLab instance |

## How search works

```
query → embed → [FTS5 top-50, vector top-50] → RRF fusion → top-N results
```

Each result includes the chunk text, file path, line range, language, and
relevance score. Ferret reads chunks in context and fetches full files only
when deeper investigation is needed.

## Architecture

See [DESIGN.md](./DESIGN.md) for the full design document covering schema,
chunking strategy, embedding approach, and incremental reindex logic.
