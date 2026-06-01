# @twonines/coder-metrics-sampler

Scrapes Prometheus metrics from Coder's `:2112/metrics` endpoint. Parses the
Prometheus text exposition format and extracts key operational indicators
including API latency percentiles, workspace counts, and agent connections.

## Install

```bash
swamp extension pull @twonines/coder-metrics-sampler
```

## Create a model instance

```bash
swamp model create @twonines/coder-metrics-sampler my-metrics-sampler \
  --global-arg 'metricsUrl=http://localhost:2112/metrics'
```

## Scrape metrics

```bash
swamp model method run my-metrics-sampler scrape
```

## Output

The `sample` resource contains:

| Field | Type | Description |
|-------|------|-------------|
| `apiRequestsTotal` | number? | Total API requests processed |
| `apiRequestLatencyP50Ms` | number? | 50th percentile API latency (ms) |
| `apiRequestLatencyP95Ms` | number? | 95th percentile API latency (ms) |
| `workspacesRunning` | number? | Count of running workspaces |
| `workspacesStopped` | number? | Count of stopped workspaces |
| `agentConnectionsTotal` | number? | Total agent connections |
| `provisionerJobsActive` | number? | Active provisioner jobs |
| `scrapeDurationMs` | number | Time taken to scrape (ms) |
| `scrapeSuccess` | boolean | Whether the scrape succeeded |
| `sampledAt` | string | ISO timestamp of the sample |
| `error` | string? | Error message if scrape failed |
| `rawMetricCount` | number | Total metrics parsed from endpoint |

## Use in workflows

```yaml
steps:
  - name: sample-metrics
    task:
      type: model_method
      modelIdOrName: my-metrics-sampler
      methodName: scrape
```

## License

MIT
