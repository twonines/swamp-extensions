# @twonines/refresh-fact-index

Refresh the local fact-store index in one workflow run. Chains
[`@twonines/fact-store`](../../extensions/models/fact-store)'s `query`
method with
[`@twonines/fact-store-index`](../../extensions/models/fact-store-index)'s
`export` method so a downstream consumer (e.g.
[`jitter`](https://codeberg.org/jhuntwork/jitter)) always has a fresh
SQLite index to serve from.

## Two-step DAG

```
┌─ query ────────────────────────────────────┐
│  method: @twonines/fact-store.query        │
│  produces: query--global data resource     │
└────────────────────────────────────────────┘
                     ↓ dependsOn: succeeded
┌─ export ───────────────────────────────────┐
│  method: @twonines/fact-store-index...export
│  reads: truth_packet via globalArg CEL:    │
│    ${{ data.latest("<facts>",              │
│         "query--global").attributes }}     │
│  writes: SQLite file at globalArg          │
│    `output_path` (default `~/.jitter/facts.db`)
└────────────────────────────────────────────┘
```

## Prerequisites

- A pulled `@twonines/fact-store` and `@twonines/fact-store-index`.
- A fact-store model instance with active facts / constraints (default
  name `facts`).
- A fact-store-index exporter model instance (default name
  `fact-index`) with globalArguments including:
  - `embed_token` — bearer token for an OpenAI-compatible embeddings
    API, sourced from a vault via `vault.get(...)`.
  - `embed_url` — the embeddings API URL (defaults to OpenAI; override
    for LiteLLM or self-hosted).
  - `truth_packet` — wired to
    `${{ data.latest("<facts-model-name>", "query--global").attributes }}`.

## Running

```bash
swamp workflow run @twonines/refresh-fact-index
```

With non-default model names or a smaller cap:

```bash
swamp workflow run @twonines/refresh-fact-index \
  --input fact_store_model=my-facts \
  --input fact_index_model=my-index \
  --input limit=500
```

## Inputs

| input              | type    | default       | description                                            |
| ------------------ | ------- | ------------- | ------------------------------------------------------ |
| `fact_store_model` | string  | `facts`       | Name of the fact-store instance to query               |
| `fact_index_model` | string  | `fact-index`  | Name of the fact-store-index exporter instance         |
| `limit`            | integer | `10000`       | Max facts to include in the truth packet               |

Note: the exporter instance's `truth_packet` CEL expression hardcodes
the fact-store model name, so if you override `fact_store_model` here
you must also update the instance yaml's `truth_packet` reference to
match. That coupling is deliberate — the CEL expression is where the
data reference actually resolves, and workflow inputs cannot rewrite
the model instance's stored config.

## Scheduling

Run under any external scheduler — swamp's own workflow scheduler, an
OS cron, a CI pipeline. Suggested cadence: nightly, aligned with the
propose→review cycle that populates new active facts.
