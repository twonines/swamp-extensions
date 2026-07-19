# @twonines/k8s-fleet

Fleet-wide Kubernetes health across all kubeconfig contexts.

## What it does

Iterates every cluster in your `~/.kube/config` (or a specified subset) and
produces per-cluster health snapshots plus an aggregated fleet summary.
Best-effort: unreachable clusters are reported with their error, not fatal.

## Methods

### `contexts`

List all available kubeconfig contexts with a quick reachability check.

### `health`

Probe each context for:

- Node conditions (Ready, MemoryPressure, DiskPressure, PIDPressure)
- Pod phase counts (Running, Pending, Failed, Succeeded, Unknown)
- CrashLoopBackOff detection
- Total restart counts

### `summary`

Aggregate health across all contexts into a single fleet view:

- Total clusters reachable/unreachable
- Total nodes ready/not-ready
- Total pods healthy/unhealthy
- Lists of unhealthy and unreachable cluster names

## Global Arguments

| Argument     | Type     | Default          | Description                        |
| ------------ | -------- | ---------------- | ---------------------------------- |
| `kubeconfig` | string   | `~/.kube/config` | Path to kubeconfig file            |
| `contexts`   | string[] | all              | Limit to these context names       |
| `timeout`    | number   | 10               | Per-context API timeout in seconds |

## Usage

```bash
# Create a model instance
swamp model create @twonines/k8s-fleet my-fleet

# List all contexts
swamp model method run my-fleet contexts

# Get per-cluster health
swamp model method run my-fleet health

# Get aggregated summary
swamp model method run my-fleet summary

# Filter to specific contexts
swamp model create @twonines/k8s-fleet prod-fleet \
  --global-arg '{"contexts": ["prod-us-east-1", "prod-us-west-2"]}'

# Read results
swamp data get my-fleet all --json | jq '.content'
```

## Example Output

```json
{
  "totalContexts": 4,
  "reachable": 3,
  "unreachable": 1,
  "totalNodes": 9,
  "nodesReady": 8,
  "nodesNotReady": 1,
  "totalPods": 142,
  "podsHealthy": 138,
  "podsUnhealthy": 4,
  "totalRestarts": 23,
  "unhealthyClusters": ["staging-us-west-2"],
  "unreachableClusters": ["old-dev-cluster"],
  "queriedAt": "2026-07-19T12:44:16.423Z"
}
```

## Design

This extension is fleet-first: every method iterates contexts automatically. You
never specify a single context — you get the fleet view. If you need
single-cluster deep-dive operations (pod logs, exec, deployment management), use
`@swamp/kubernetes` which provides comprehensive per-cluster tooling.

The two compose well: use `@twonines/k8s-fleet` for the "is everything OK?"
check, then `@swamp/kubernetes` to investigate specific clusters that need
attention.
