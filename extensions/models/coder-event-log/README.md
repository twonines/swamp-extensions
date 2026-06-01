# @twonines/coder-event-log

Records webhook payloads received from Coder notifications. Each event is stored
with its receipt timestamp and parsed metadata, enabling delivery latency and
reliability analysis.

## Install

```bash
swamp extension pull @twonines/coder-event-log
```

## Create a model instance

```bash
swamp model create @twonines/coder-event-log my-event-log
```

## Record an event

Typically invoked by a webhook-triggered workflow rather than manually:

```bash
swamp model method run my-event-log record \
  --input 'payload={"msg_id":"abc-123","title":"Workspace started"}'
```

## Webhook workflow integration

Use with `swamp serve --webhook` to automatically record Coder notification
events:

```bash
swamp serve --webhook "/coder-events:my-event-reactor:my-secret"
```

```yaml
# workflow triggered by the webhook
steps:
  - name: record
    task:
      type: model_method
      modelIdOrName: my-event-log
      methodName: record
      inputs:
        payload: "${{ inputs.payload }}"
```

## Output

The `event` resource (keyed by `msg_id`) contains:

| Field | Type | Description |
|-------|------|-------------|
| `msgId` | string | Unique message identifier |
| `title` | string | Notification title |
| `body` | string? | Notification body |
| `notificationName` | string? | Coder notification type name |
| `labels` | object? | Key-value labels from the notification |
| `actions` | array? | Action links (label + url) |
| `receivedAt` | string | ISO timestamp of receipt |
| `rawPayloadSize` | number | Size of the raw JSON payload in bytes |

## License

MIT
