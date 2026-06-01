# @twonines/coder-workspace-watch

Queries the Coder workspace API and captures point-in-time state snapshots.
Records workspace status, agent health, build info, and template association
for stability monitoring and drift detection.

## Install

```bash
swamp extension pull @twonines/coder-workspace-watch
```

## Create a model instance

```bash
swamp model create @twonines/coder-workspace-watch my-workspace-watch \
  --global-arg 'url=http://localhost:3000' \
  --global-arg 'token=$${{ vault.get(my-vault, CODER_TOKEN) }}'
```

## Observe a workspace

```bash
swamp model method run my-workspace-watch observe --input 'workspace=my-sandbox'
```

## Output

The `snapshot` resource (keyed by workspace name) contains:

| Field | Type | Description |
|-------|------|-------------|
| `workspaceId` | string | Coder workspace UUID |
| `workspaceName` | string | Workspace name |
| `ownerName` | string | Owner username |
| `status` | string | Current workspace status |
| `latestBuildStatus` | string? | Status of the most recent build |
| `agentStatus` | string? | Agent connection status |
| `agentVersion` | string? | Agent version string |
| `templateName` | string? | Associated template name |
| `createdAt` | string? | Workspace creation time |
| `lastUsedAt` | string? | Last activity time |
| `observedAt` | string | ISO timestamp of this observation |
| `error` | string? | Error if observation failed |

## Use in workflows

```yaml
steps:
  - name: observe-workspace
    task:
      type: model_method
      modelIdOrName: my-workspace-watch
      methodName: observe
      inputs:
        workspace: my-sandbox
```

## License

MIT
