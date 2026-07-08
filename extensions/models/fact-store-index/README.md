# @twonines/fact-store-index

Exports `@twonines/fact-store` active facts and constraints into a portable
SQLite file with FTS5 full-text search plus raw vector embeddings, so
downstream tools (like [`jitter`](https://codeberg.org/jhuntwork/jitter)) can
assemble just-in-time truth packets for AI agents without querying swamp on
every prompt.

## Why

The swamp fact-store is the authoritative propose→review→activate lifecycle for
operational facts, but querying it takes multiple CLI invocations and hundreds
of milliseconds — fine for periodic consumption, wrong shape for a prompt hook
that fires on every user turn. This extension materializes the current fact-set
into a self-contained SQLite file that opens instantly and supports hybrid
retrieval (BM25 over `searchable_text` + cosine similarity over embeddings).

## What it produces

A single SQLite file with the following schema:

| table         | purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `facts`       | one row per active fact — kind, scope, subject, value, tier, text   |
| `facts_fts`   | FTS5 index over `searchable_text` (BM25)                            |
| `constraints` | one row per active constraint — kind, scope, rule, rationale, tags  |
| `constraints_fts` | FTS5 index over constraint text                                 |
| `manifest`    | one row: `exported_at`, `embed_model`, `embed_dim`, counts, source  |

Embeddings are stored as raw f32 BLOBs directly on `facts` and `constraints`
rows so consumers can compute cosine similarity in-process without loading a
separate vector index.

## Usage

Add a swamp vault for your embeddings token, then create an instance:

```bash
swamp vault put my-secrets embed-token
swamp model create @twonines/fact-store-index/exporter fact-index \
  --global-arg 'embed_token=${{ vault.get("my-secrets", "embed-token") }}'
```

Run it against the output of a fact-store query:

```bash
swamp model method run fact-index export \
  --arg 'truth_packet=${{ data.latest("facts", "query--global").attributes }}' \
  --json
```

The `truth_packet` input is the full attributes object from
`@twonines/fact-store`'s `query` method — the exporter destructures `.facts`
and `.constraints` internally.

## Configuration

| globalArgument | required | default                          | description                                          |
| -------------- | -------- | -------------------------------- | ---------------------------------------------------- |
| `output_path`  | no       | `~/.jitter/facts.db`             | Absolute path for the SQLite file                    |
| `embed_url`    | no       | `https://api.openai.com/v1`      | OpenAI-compatible embeddings API base URL            |
| `embed_model`  | no       | `text-embedding-3-small`         | Embedding model id                                   |
| `embed_dim`    | no       | `1536`                           | Expected embedding dimension                         |
| `embed_token`  | yes      | —                                | Bearer token (source from a vault, never inline)     |
| `batch_size`   | no       | `32`                             | Max texts per embedding API call                     |

## Consumers

Any tool that can open SQLite and speak the OpenAI embeddings API can consume
the index. The [`jitter`](https://codeberg.org/jhuntwork/jitter) binary is the
reference consumer — it embeds the current user prompt, combines BM25 hits with
cosine similarity, and emits a compact truth packet in <100ms.

## Design notes

- **Provider-agnostic.** Any OpenAI-compatible endpoint works — OpenAI,
  LiteLLM, vLLM, hosted or self-hosted. Model + dimension are recorded in the
  SQLite `manifest` table so consumers can validate their query-side
  embedding matches the corpus embedding.
- **No entity resolution in slice 1.** Facts are indexed by their raw
  subject identity. Cross-alias resolution (e.g. account ID ↔ account name)
  is planned for a later slice; existing subject-ref data is captured in the
  schema so resolution can be added without re-embedding.
- **No incremental updates.** The exporter rewrites the SQLite file each run.
  For a corpus of a few thousand facts this is trivially fast; scaling
  concerns come later.
