# @twonines/eks-upgrade-insights

AWS EKS Upgrade Insights for upgrade readiness.

## What it does

Given one or more EKS cluster names, this model reads each cluster's AWS
`UPGRADE_READINESS` insights and records one finding per cluster. It surfaces
the checks AWS itself runs ahead of a control-plane upgrade:

- Control-plane health
- Add-on compatibility
- `kube-proxy` / `kubelet` version skew
- **Deprecated-API usage** detected from audit logs over the last 30 days —
  which a live-object scan cannot see, because it catches client traffic, not
  just stored objects

Each `ERROR` or `WARNING` insight is flagged as actionable and carries its AWS
remediation detail, including the client user-agents still calling soon-to-be
removed APIs and how often.

Credentials come from the ambient AWS credential chain (environment variables,
SSO cache, named profile, or instance role) at call time. Nothing is stored by
this model, which deliberately suits short-lived STS credentials.

## Methods

### `inspect`

Read AWS EKS Upgrade Insights for one or more clusters in a single fan-out run.
Writes one `insight` finding per cluster. A cluster that fails to inspect is
recorded with `ok: false` and never aborts the others.

| Argument      | Type       | Default | Description                                          |
| ------------- | ---------- | ------- | ---------------------------------------------------- |
| `clusters`    | `string[]` | —       | EKS cluster names (as AWS knows them), one or many   |
| `allClusters` | `boolean`  | `false` | Discover and inspect every EKS cluster in the region |

## Global Arguments

| Argument  | Type     | Default                             | Description                            |
| --------- | -------- | ----------------------------------- | -------------------------------------- |
| `region`  | `string` | `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region to inspect                  |
| `profile` | `string` | ambient credential chain            | Named profile for the credential chain |

## Usage

```bash
# Create a model instance pinned to a region
swamp model create @twonines/eks-upgrade-insights eks-prod \
  --global-arg '{"region": "us-east-1"}'

# Inspect specific clusters
swamp model @twonines/eks-upgrade-insights method run inspect eks-prod \
  --arg '{"clusters": ["prod-use1", "prod-usw2"]}'

# Or discover and inspect every cluster in the region
swamp model @twonines/eks-upgrade-insights method run inspect eks-prod \
  --arg '{"allClusters": true}'
```

The `inspect` method emits the `@twonines/eks-upgrade-insights/eks-insights`
report, which consolidates every per-cluster finding into one actionable view: a
per-cluster summary table, then the `ERROR` / `WARNING` insights with their AWS
recommendation and the deprecated-API usage detail.

## Example finding (JSON)

```json
{
  "cluster": "prod-use1",
  "region": "us-east-1",
  "inspectedAt": "2026-10-23T18:04:11.000Z",
  "errorCount": 1,
  "warningCount": 0,
  "actionableCount": 1,
  "ok": true,
  "insights": [
    {
      "name": "Deprecated APIs removed in Kubernetes v1.29",
      "status": "ERROR",
      "kubernetesVersion": "1.29",
      "recommendation": "Migrate manifests off the removed API versions.",
      "deprecationDetails": [
        {
          "usage": "flowcontrol.apiserver.k8s.io/v1beta2 FlowSchema",
          "replacedWith": "flowcontrol.apiserver.k8s.io/v1",
          "stopServingVersion": "1.29",
          "clients": [
            { "userAgent": "kubectl/v1.27.3", "requestsLast30Days": 42 }
          ]
        }
      ]
    }
  ]
}
```

## Required AWS permissions

The credential in use needs `eks:ListInsights` and `eks:DescribeInsight`, plus
`eks:ListClusters` when `allClusters` is set.
