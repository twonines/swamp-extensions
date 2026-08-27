# @twonines/cribl-stream

Read-only integration for troubleshooting [Cribl Stream](https://cribl.io/) Cloud deployments via the REST API.

A fork of [@figura/cribl-stream](https://github.com/ftveronezzi/swamp-extensions) with more methods — this is the place to improve on it.

| | |
|---|---|
| **Scope** | Read-only — no mutations are ever performed on your Cribl environment |
| **Auth** | OAuth2 `client_credentials` (Cribl Cloud API Client ID/Secret) |
| **Methods** | 19 |
| **License** | MIT |

## Installation

```bash
swamp extension pull @twonines/cribl-stream
```

## Authentication

Requires a Cribl Cloud API Client ID and Client Secret. Generate credentials in Cribl Cloud under **Settings → API Credentials** and store them in a swamp vault.

## Methods

### Configuration

What's deployed in a worker group, and how it's wired together.

| Method | Description |
|---|---|
| `list_sources` | List all input sources in a worker group |
| `get_source` | Get detailed config for a specific source |
| `list_routes` | List routes with filter, pipeline, and output mappings |
| `list_pipelines` | List all pipelines in a worker group |
| `get_pipeline` | Get pipeline config including all functions |
| `list_destinations` | List output destinations with status |
| `get_destination` | Get detailed config for a destination |
| `list_lookups` | List lookup files in a worker group |
| `list_knowledge` | List knowledge objects (parsers, vars, schemas) |

### Live data

Events flowing through the pipeline right now.

| Method | Description |
|---|---|
| `capture_events` | Capture/preview live events at a pipeline point |

### Health, logs & alerting

What config alone won't tell you — actual runtime state.

| Method | Description |
|---|---|
| `health` | Fan-out health check across all sources, routes, pipelines, and destinations |
| `list_notifications` | Cribl's own raised/resolved alert feed for a worker group |
| `list_log_files` | List available log files for a worker group instance |
| `get_log_lines` | Read parsed events from one log file, with an optional filter expression |

### Cribl status page

Unauthenticated calls to `status.cribl.cloud` — no worker group or credentials needed.

| Method | Description |
|---|---|
| `check_status_page` | Current system indicator, unresolved incidents, and active maintenances |
| `list_status_page_incidents` | Historical incidents (resolved and unresolved), most recent first |

### Per-node status (bypassing leader aggregation)

`list_sources`/`get_source`/`health` read a leader-aggregated view of a worker group. On Cribl Cloud that aggregated view has been observed to report `numRequests: 0` for a source that is, per-node, actively processing tens of thousands of events — these three read one worker node directly instead.

| Method | Description |
|---|---|
| `list_workers` | List worker nodes org-wide (id, health, worker group, hostname) |
| `get_node_input_status` | One worker node's own live status/metrics for one input |
| `get_node_output_status` | One worker node's own live status/metrics for one output |

## Usage

```bash
# List all sources in the "default" worker group
swamp model method run cribl-stream list_sources --set workerGroup=default

# Get detailed config for a specific pipeline
swamp model method run cribl-stream get_pipeline --set workerGroup=default --set pipelineId=my-syslog-pipeline

# Capture 5 live events from a source
swamp model method run cribl-stream capture_events --set workerGroup=default --set sourceId=syslog-in --set maxEvents=5

# Run a health check across the worker group
swamp model method run cribl-stream health --set workerGroup=default

# Search cribl.log for anything mentioning a destination, past the live tail
swamp model method run cribl-stream get_log_lines \
  --set workerGroup=default \
  --set fileId='__instance__:cribl.log' \
  --set filter="_raw.includes('my-destination')"

# Check whether Cribl itself has an ongoing incident
swamp model method run cribl-stream check_status_page

# Find a worker group's node ids, then read one node's real traffic directly
swamp model method run cribl-stream list_workers
swamp model method run cribl-stream get_node_input_status \
  --set nodeId=<node-id-from-list_workers> --set sourceId=open_telemetry
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
