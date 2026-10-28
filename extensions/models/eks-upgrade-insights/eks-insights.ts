/**
 * EKS Upgrade Insights report for `@twonines/eks-upgrade-insights/cluster`.
 *
 * Method-scope report: runs after an `inspect` run and consolidates every
 * per-cluster insight finding into one actionable view. Surfaces ERROR and
 * WARNING insights with their AWS recommendation and the deprecated-API usage
 * detail (client user-agents and 30-day request counts) that tells you which
 * workloads to fix before upgrading. Reads only this extension's own findings —
 * no kubeconfig, no cross-extension dependency.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

// deno-lint-ignore no-explicit-any
type Any = any;

interface DataHandle {
  name: string;
  version?: number;
  specName?: string;
}

interface Ctx {
  modelType: Any;
  modelId: string;
  methodArgs: Record<string, unknown>;
  executionStatus: "succeeded" | "failed";
  dataHandles: DataHandle[];
  dataRepository: {
    getContent(
      type: Any,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
  logger: { info(m: string, p?: Record<string, unknown>): void };
}

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
  status: z.string(),
  reason: z.string(),
  description: z.string(),
  lastRefreshTime: z.string(),
  lastTransitionTime: z.string(),
  recommendation: z.string(),
  deprecationDetails: z.array(DeprecationDetailSchema),
});

const FindingSchema = z.object({
  cluster: z.string(),
  region: z.string(),
  inspectedAt: z.string(),
  insights: z.array(InsightSchema),
  errorCount: z.number(),
  warningCount: z.number(),
  actionableCount: z.number(),
  ok: z.boolean(),
  error: z.string(),
}).passthrough();

type Finding = z.infer<typeof FindingSchema>;

async function readFindings(context: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const h of context.dataHandles ?? []) {
    if (h.specName && h.specName !== "insight") continue;
    const bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      h.name,
      h.version,
    );
    if (!bytes) continue;
    try {
      out.push(
        FindingSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
      );
    } catch {
      // not an insight finding
    }
  }
  return out;
}

function clientSummary(d: z.infer<typeof DeprecationDetailSchema>): string {
  return d.clients
    .map((c) => `${c.userAgent} (${c.requestsLast30Days}/30d)`)
    .join(", ") || "(no client stats)";
}

/**
 * Method-scope report that consolidates every per-cluster EKS Upgrade Insights
 * finding from an `inspect` run into one actionable Markdown + JSON view.
 */
export const report = {
  name: "@twonines/eks-upgrade-insights/eks-insights",
  description:
    "Consolidated AWS EKS Upgrade Insights across every cluster inspected in the run: actionable ERROR/WARNING checks with AWS remediation and the deprecated-API usage detail (which client user-agents are still calling soon-to-be-removed APIs, and how often).",
  scope: "method" as const,
  labels: ["aws", "eks", "upgrade", "insights", "readiness"],
  execute: async (context: Ctx) => {
    const findings = await readFindings(context);

    const inspected = findings.filter((f) => f.ok);
    const failed = findings.filter((f) => !f.ok);
    const totalError = inspected.reduce((n, f) => n + f.errorCount, 0);
    const totalWarning = inspected.reduce((n, f) => n + f.warningCount, 0);
    const clustersActionable = inspected.filter((f) => f.actionableCount > 0);
    const overallClear = totalError === 0 && totalWarning === 0 &&
      failed.length === 0;

    const md: string[] = [];
    md.push("# EKS Upgrade Insights");
    md.push("");
    md.push(`- **Clusters inspected**: ${inspected.length}`);
    md.push(
      `- **Clusters with actionable insights**: ${clustersActionable.length}`,
    );
    md.push(`- **ERROR insights**: ${totalError}`);
    md.push(`- **WARNING insights**: ${totalWarning}`);
    if (failed.length > 0) {
      md.push(`- **Clusters that failed to inspect**: ${failed.length}`);
    }
    md.push(
      `- **Overall**: ${overallClear ? "CLEAR ✅" : "ACTION REQUIRED ❌"}`,
    );
    md.push("");

    // Per-cluster summary.
    md.push("## Per-cluster summary");
    md.push("");
    md.push("| Cluster | Region | Insights | ERROR | WARNING | Status |");
    md.push("| --- | --- | --- | --- | --- | --- |");
    for (const f of findings) {
      const status = !f.ok
        ? "INSPECT FAILED ❌"
        : f.errorCount > 0
        ? "ERROR ❌"
        : f.warningCount > 0
        ? "WARNING ⚠️"
        : "CLEAR ✅";
      md.push(
        `| ${f.cluster} | ${f.region} | ${f.insights.length} | ${f.errorCount} | ${f.warningCount} | ${status} |`,
      );
    }
    md.push("");

    // Actionable insight detail.
    if (clustersActionable.length > 0) {
      md.push("## Actionable insights (fix before upgrade)");
      md.push("");
      for (const f of clustersActionable) {
        const actionable = f.insights.filter((i) =>
          i.status === "ERROR" || i.status === "WARNING"
        );
        for (const i of actionable) {
          const mark = i.status === "ERROR" ? "❌ ERROR" : "⚠️ WARNING";
          md.push(
            `### ${mark} — ${f.cluster}: ${i.name} (targets ${i.kubernetesVersion})`,
          );
          md.push("");
          md.push(`${i.reason}`);
          md.push("");
          if (i.recommendation) {
            md.push(`**Recommendation:** ${i.recommendation}`);
            md.push("");
          }
          if (i.deprecationDetails.length > 0) {
            md.push(
              "| Deprecated usage | Replace with | Stops serving | Clients (requests/30d) |",
            );
            md.push("| --- | --- | --- | --- |");
            for (const d of i.deprecationDetails) {
              md.push(
                `| ${d.usage} | ${
                  d.replacedWith || "(removed)"
                } | ${d.stopServingVersion} | ${clientSummary(d)} |`,
              );
            }
            md.push("");
          }
        }
      }
    }

    // Failed clusters.
    if (failed.length > 0) {
      md.push("## Clusters that failed to inspect");
      md.push("");
      md.push("| Cluster | Region | Error |");
      md.push("| --- | --- | --- |");
      for (const f of failed) {
        md.push(`| ${f.cluster} | ${f.region} | ${f.error} |`);
      }
      md.push("");
    }

    return {
      markdown: md.join("\n"),
      json: {
        clustersInspected: inspected.length,
        clustersActionable: clustersActionable.length,
        clustersFailed: failed.length,
        totalError,
        totalWarning,
        overallClear,
        clusters: findings.map((f) => ({
          cluster: f.cluster,
          region: f.region,
          ok: f.ok,
          error: f.error,
          errorCount: f.errorCount,
          warningCount: f.warningCount,
          insights: f.insights,
        })),
      },
    };
  },
};
