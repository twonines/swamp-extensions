/**
 * Unit tests for @twonines/eks-upgrade-insights report.
 * Validates consolidation of per-cluster findings into the actionable view.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { report } from "./eks-insights.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Build a minimal report context whose dataRepository serves the given
 * findings, one per data handle (spec name "insight").
 */
function makeContext(findings: Any[]): Any {
  const encoder = new TextEncoder();
  const byName = new Map<string, Uint8Array>();
  const dataHandles = findings.map((f, i) => {
    const name = `${f.cluster ?? "finding"}-${i}`;
    byName.set(name, encoder.encode(JSON.stringify(f)));
    return { name, specName: "insight", version: 1 };
  });
  return {
    modelType: {},
    modelId: "eks",
    methodArgs: {},
    executionStatus: "succeeded",
    dataHandles,
    dataRepository: {
      getContent: (_t: Any, _m: string, dataName: string) =>
        Promise.resolve(byName.get(dataName) ?? null),
    },
    logger: { info() {} },
  };
}

const errorFinding = {
  cluster: "prod-use1",
  region: "us-east-1",
  inspectedAt: "2026-10-23T00:00:00.000Z",
  errorCount: 1,
  warningCount: 0,
  actionableCount: 1,
  ok: true,
  error: "",
  insights: [
    {
      id: "ins-1",
      name: "Deprecated APIs removed in v1.29",
      category: "UPGRADE_READINESS",
      kubernetesVersion: "1.29",
      status: "ERROR",
      reason: "deprecated APIs in use",
      description: "",
      lastRefreshTime: "",
      lastTransitionTime: "",
      recommendation: "Migrate off the removed API versions.",
      deprecationDetails: [
        {
          usage: "flowcontrol.apiserver.k8s.io/v1beta2 FlowSchema",
          replacedWith: "flowcontrol.apiserver.k8s.io/v1",
          stopServingVersion: "1.29",
          startServingReplacementVersion: "1.26",
          clients: [
            {
              userAgent: "kubectl/v1.27.3",
              requestsLast30Days: 42,
              lastRequestTime: "2026-10-22T00:00:00.000Z",
            },
          ],
        },
      ],
    },
  ],
};

const clearFinding = {
  cluster: "prod-usw2",
  region: "us-west-2",
  inspectedAt: "2026-10-23T00:00:00.000Z",
  errorCount: 0,
  warningCount: 0,
  actionableCount: 0,
  ok: true,
  error: "",
  insights: [],
};

const failedFinding = {
  cluster: "broken",
  region: "us-east-1",
  inspectedAt: "2026-10-23T00:00:00.000Z",
  errorCount: 0,
  warningCount: 0,
  actionableCount: 0,
  ok: false,
  error: "AccessDenied",
  insights: [],
};

Deno.test("report - consolidates actionable ERROR insight with deprecation detail", async () => {
  const out = await report.execute(makeContext([errorFinding, clearFinding]));
  assertEquals(out.json.clustersInspected, 2);
  assertEquals(out.json.clustersActionable, 1);
  assertEquals(out.json.totalError, 1);
  assertEquals(out.json.overallClear, false);

  const md = out.markdown;
  assertEquals(md.includes("# EKS Upgrade Insights"), true);
  assertEquals(md.includes("ACTION REQUIRED"), true);
  assertEquals(md.includes("Migrate off the removed API versions."), true);
  assertEquals(md.includes("kubectl/v1.27.3 (42/30d)"), true);
});

Deno.test("report - all clear when no actionable insights and no failures", async () => {
  const out = await report.execute(makeContext([clearFinding]));
  assertEquals(out.json.overallClear, true);
  assertEquals(out.markdown.includes("CLEAR"), true);
});

Deno.test("report - surfaces clusters that failed to inspect", async () => {
  const out = await report.execute(makeContext([failedFinding]));
  assertEquals(out.json.clustersFailed, 1);
  assertEquals(out.json.overallClear, false);
  assertEquals(out.markdown.includes("Clusters that failed to inspect"), true);
  assertEquals(out.markdown.includes("AccessDenied"), true);
});
