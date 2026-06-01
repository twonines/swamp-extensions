# @twonines/coder-audit-collector

Pages through the Coder audit log API and writes batches of events as versioned
data. Supports configurable limits and query filters for targeted collection.

## Install

```bash
swamp extension pull @twonines/coder-audit-collector
```

## Create a model instance

```bash
swamp model create @twonines/coder-audit-collector my-audit-collector \
  --global-arg 'url=http://localhost:3000' \
  --global-arg 'token=$${{ vault.get(my-vault, CODER_TOKEN) }}'
```

## Collect audit events

```bash
swamp model method run my-audit-collector collect --input 'limit=50'
```

With a query filter:

```bash
swamp model method run my-audit-collector collect \
  --input 'limit=25' \
  --input 'query=action:create'
```

## Output

The `batch` resource contains:

| Field | Type | Description |
|-------|------|-------------|
| `events` | array | List of audit event objects |
| `count` | number | Number of events in this batch |
| `oldestEvent` | string? | Timestamp of the oldest event |
| `newestEvent` | string? | Timestamp of the newest event |
| `collectedAt` | string | ISO timestamp of collection |
| `error` | string? | Error message if collection failed |

Each event contains `id`, `time`, `action`, `resourceType`, `resourceId`,
`userId`, `statusCode`, and `description`.

## Use in workflows

```yaml
steps:
  - name: collect-audit
    task:
      type: model_method
      modelIdOrName: my-audit-collector
      methodName: collect
      inputs:
        limit: 50
```

## License

MIT
