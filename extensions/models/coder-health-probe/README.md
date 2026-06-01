# @twonines/coder-health-probe

Polls Coder server `/healthz` and `/api/v2/buildinfo` endpoints with timed
requests. Produces a typed health state including reachability status, server
version, and response latency for each endpoint.

## Install

```bash
swamp extension pull @twonines/coder-health-probe
```

## Create a model instance

```bash
swamp model create @twonines/coder-health-probe my-health-probe \
  --global-arg 'url=http://localhost:3000'
```

## Run a health check

```bash
swamp model method run my-health-probe check
```

## Output

The `probe` resource contains:

| Field | Type | Description |
|-------|------|-------------|
| `healthy` | boolean | True when both endpoints respond OK |
| `status` | enum | `reachable`, `unhealthy`, or `unreachable` |
| `version` | string? | Server version from buildinfo |
| `healthzLatencyMs` | number | Response time for /healthz |
| `buildinfoLatencyMs` | number | Response time for /api/v2/buildinfo |
| `checkedAt` | string | ISO timestamp of the check |
| `error` | string? | Error message if either endpoint failed |

## Use in workflows

```yaml
steps:
  - name: check-health
    task:
      type: model_method
      modelIdOrName: my-health-probe
      methodName: check
```

## License

MIT
