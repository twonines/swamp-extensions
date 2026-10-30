/**
 * AWS EKS Upgrade Insights for upgrade readiness.
 *
 * This is the EKS-specific companion to the generic k8s-upgrade scanner. Where
 * that model scans live Kubernetes objects for removed APIs (provider-neutral),
 * this one reads AWS's own UPGRADE_READINESS insights for a cluster:
 * control-plane health, add-on compatibility, kube-proxy/kubelet version skew,
 * and — crucially — deprecated-API *usage* detected from audit logs over the
 * last 30 days, which a live-object scan cannot see (it catches client traffic,
 * not just stored objects).
 *
 * It calls `eks:ListInsights` and `eks:DescribeInsight` via `@aws-sdk/client-eks`,
 * flagging ERROR/WARNING insights as actionable.
 *
 * Credentials: the ambient AWS credential chain (env vars, SSO, named profile)
 * is used at call time. Nothing is stored by this model — this deliberately
 * suits short-lived/ephemeral STS credentials, which a secret store would only
 * hold stale.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";
import {
  DescribeInsightCommand,
  EKSClient,
  ListClustersCommand,
  ListInsightsCommand,
} from "npm:@aws-sdk/client-eks@3.1139.0";

const GlobalArgsSchema = z.object({
  // AWS region. Falls back to AWS_REGION / AWS_DEFAULT_REGION when omitted.
  region: z.string().optional(),
  // Named profile for the credential chain. Omit to use the default/ambient
  // environment credentials (env vars, SSO cache, instance role, etc.).
  profile: z.string().optional(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Ctx {
  globalArgs: GlobalArgs;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
    error(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

// -----------------------------------------------------------------------------
// Finding schema — one data resource per cluster.
// -----------------------------------------------------------------------------

const DeprecationDetailSchema = z.object({
  usage: z.string(),
  replacedWith: z.string(),
  stopServingVersion: z.string(),
  startServingReplacementVersion: z.string(),
  clients: z.array(z.object({
    userAgent: z.string(),
    requestsLast30Days: z.number(),
    lastRequestTime: z.string(),
  })),
});

const InsightSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  kubernetesVersion: z.string(),
  status: z.string(), // PASSING | WARNING | ERROR | UNKNOWN
  reason: z.string(),
  description: z.string(),
  lastRefreshTime: z.string(),
  lastTransitionTime: z.string(),
  // Populated from describe-insight for non-PASSING insights.
  recommendation: z.string(),
  deprecationDetails: z.array(DeprecationDetailSchema),
});

const FindingSchema = z.object({
  cluster: z.string(),
  region: z.string(),
  inspectedAt: z.string(),
  insights: z.array(InsightSchema),
  // Actionable = ERROR or WARNING. errorCount tracks ERROR specifically, which
  // is the primary blocking condition for an upgrade.
  errorCount: z.number(),
  warningCount: z.number(),
  actionableCount: z.number(),
  ok: z.boolean(),
  error: z.string(),
}).passthrough();

// -----------------------------------------------------------------------------
// EKS client + inspection.
// -----------------------------------------------------------------------------

function buildClient(args: GlobalArgs): EKSClient {
  const cfg: { region?: string } = {};
  if (args.region) cfg.region = args.region;
  // profile is honored via env (AWS_PROFILE); the SDK default chain reads it.
  // Setting it explicitly keeps behavior predictable when passed as an arg.
  if (args.profile) Deno.env.set("AWS_PROFILE", args.profile);
  return new EKSClient(cfg);
}

async function inspectOneCluster(
  client: EKSClient,
  region: string,
  clusterName: string,
  ctx: Ctx,
): Promise<z.infer<typeof FindingSchema>> {
  const listed = await client.send(
    new ListInsightsCommand({ clusterName }),
  );
  const summaries = listed.insights ?? [];
  const insights: z.infer<typeof InsightSchema>[] = [];

  for (const s of summaries) {
    const status = s.insightStatus?.status ?? "UNKNOWN";
    let recommendation = "";
    let deprecationDetails: z.infer<typeof DeprecationDetailSchema>[] = [];

    // Pull full detail only for non-passing insights (saves API calls).
    if (status !== "PASSING" && s.id) {
      try {
        const detail = await client.send(
          new DescribeInsightCommand({ clusterName, id: s.id }),
        );
        const ins = detail.insight;
        recommendation = ins?.recommendation ?? "";
        const dd = ins?.categorySpecificSummary?.deprecationDetails ?? [];
        deprecationDetails = dd.map((d) => ({
          usage: d.usage ?? "",
          replacedWith: d.replacedWith ?? "",
          stopServingVersion: d.stopServingVersion ?? "",
          startServingReplacementVersion: d.startServingReplacementVersion ??
            "",
          clients: (d.clientStats ?? []).map((c) => ({
            userAgent: c.userAgent ?? "",
            requestsLast30Days: c.numberOfRequestsLast30Days ?? 0,
            lastRequestTime: c.lastRequestTime
              ? new Date(c.lastRequestTime).toISOString()
              : "",
          })),
        }));
      } catch (e) {
        ctx.logger.warning(
          "describe-insight failed for {id} on {cluster}: {err}",
          {
            id: s.id,
            cluster: clusterName,
            err: e instanceof Error ? e.message : String(e),
          },
        );
      }
    }

    insights.push({
      id: s.id ?? "",
      name: s.name ?? "",
      category: s.category ?? "",
      kubernetesVersion: s.kubernetesVersion ?? "",
      status,
      reason: s.insightStatus?.reason ?? "",
      description: s.description ?? "",
      lastRefreshTime: s.lastRefreshTime
        ? new Date(s.lastRefreshTime).toISOString()
        : "",
      lastTransitionTime: s.lastTransitionTime
        ? new Date(s.lastTransitionTime).toISOString()
        : "",
      recommendation,
      deprecationDetails,
    });
  }

  const errorCount = insights.filter((i) => i.status === "ERROR").length;
  const warningCount = insights.filter((i) => i.status === "WARNING").length;
  return {
    cluster: clusterName,
    region,
    inspectedAt: new Date().toISOString(),
    insights,
    errorCount,
    warningCount,
    actionableCount: errorCount + warningCount,
    ok: true,
    error: "",
  };
}

const InspectArgs = z.object({
  // EKS cluster names (as AWS knows them, e.g. "my-prod-cluster"). One or
  // many. Note these are AWS cluster names, NOT kubeconfig context names.
  clusters: z.array(z.string()).optional(),
  // Discover and inspect every EKS cluster in the region instead.
  allClusters: z.boolean().default(false),
});

/**
 * EKS Upgrade Insights model. Exposes the `inspect` method, which reads AWS
 * `UPGRADE_READINESS` insights for one or more clusters and writes one
 * `insight` finding per cluster.
 */
export const model = {
  type: "@twonines/eks-upgrade-insights/cluster",
  version: "2026.10.23.1",
  globalArguments: GlobalArgsSchema,
  reports: ["@twonines/eks-upgrade-insights/eks-insights"],
  resources: {
    insight: {
      description:
        "One EKS cluster's Upgrade Insights: every UPGRADE_READINESS check with its status (PASSING/WARNING/ERROR), reason, and — for non-passing checks — the AWS recommendation and deprecated-API usage detail (client user-agents and 30-day request counts). ok=false with an error message when the cluster could not be inspected.",
      schema: FindingSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    inspect: {
      description:
        "Read AWS EKS Upgrade Insights for one or more clusters in a single fan-out run. Provide clusters=[...] (AWS cluster names, one or many) or allClusters=true to discover them. Writes one insight finding per cluster, flagging ERROR/WARNING insights as actionable and attaching their remediation detail; a cluster that fails to inspect is recorded with ok=false and never aborts the others. Uses the ambient AWS credential chain.",
      arguments: InspectArgs,
      execute: async (
        args: z.infer<typeof InspectArgs>,
        context: Ctx,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const client = buildClient(g);
        const region = await client.config.region();

        let clusters = args.clusters ?? [];
        if (args.allClusters) {
          const all: string[] = [];
          let nextToken: string | undefined;
          do {
            const resp = await client.send(
              new ListClustersCommand({ nextToken }),
            );
            all.push(...(resp.clusters ?? []));
            nextToken = resp.nextToken;
          } while (nextToken);
          clusters = all;
        }
        if (clusters.length === 0) {
          throw new Error(
            "no clusters selected; pass clusters=['name', ...] (one or many) or allClusters=true",
          );
        }
        context.logger.info(
          "Inspecting {n} EKS cluster(s) in {region}: {list}",
          {
            n: clusters.length,
            region,
            list: clusters.join(", "),
          },
        );

        const handles: { name: string }[] = [];
        for (const clusterName of clusters) {
          try {
            const finding = await inspectOneCluster(
              client,
              region,
              clusterName,
              context,
            );
            context.logger.info(
              "✓ {cluster}: {err} error / {warn} warning insight(s)",
              {
                cluster: clusterName,
                err: finding.errorCount,
                warn: finding.warningCount,
              },
            );
            handles.push(
              await context.writeResource("insight", clusterName, finding),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            context.logger.warning("✗ {cluster} inspect failed: {err}", {
              cluster: clusterName,
              err: msg,
            });
            const failed = {
              cluster: clusterName,
              region,
              inspectedAt: new Date().toISOString(),
              insights: [],
              errorCount: 0,
              warningCount: 0,
              actionableCount: 0,
              ok: false,
              error: msg,
            };
            handles.push(
              await context.writeResource("insight", clusterName, failed),
            );
          }
        }
        return { dataHandles: handles };
      },
    },
  },
};
