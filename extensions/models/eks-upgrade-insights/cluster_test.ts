/**
 * Unit tests for @twonines/eks-upgrade-insights model.
 * Validates insight inspection against a mocked EKSClient.send.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { EKSClient } from "npm:@aws-sdk/client-eks@3.1139.0";
import { model } from "./cluster.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Patch EKSClient.prototype.send to answer by command constructor name, and
 * stub config.region(), for the duration of `fn`. Restores both afterward.
 */
async function withMockEks(
  handlers: {
    region?: string;
    listInsights?: (input: Any) => Any;
    describeInsight?: (input: Any) => Any;
    listClusters?: (input: Any) => Any;
  },
  fn: () => Promise<void>,
): Promise<void> {
  const originalSend = EKSClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  (EKSClient.prototype as any).send = function (command: Any) {
    const name = command?.constructor?.name ?? "";
    const input = command?.input ?? {};
    if (name === "ListInsightsCommand") {
      return Promise.resolve(
        handlers.listInsights?.(input) ?? { insights: [] },
      );
    }
    if (name === "DescribeInsightCommand") {
      return Promise.resolve(
        handlers.describeInsight?.(input) ?? { insight: {} },
      );
    }
    if (name === "ListClustersCommand") {
      return Promise.resolve(
        handlers.listClusters?.(input) ?? { clusters: [] },
      );
    }
    return Promise.reject(new Error(`unexpected command: ${name}`));
  };
  // config.region() is read by the method; make it resolve to a fixed region.
  const originalRegion = EKSClient.prototype.config?.region;
  // deno-lint-ignore no-explicit-any
  (EKSClient.prototype as any).config = {
    region: () => Promise.resolve(handlers.region ?? "us-east-1"),
  };
  try {
    await fn();
  } finally {
    EKSClient.prototype.send = originalSend;
    if (originalRegion) {
      // deno-lint-ignore no-explicit-any
      (EKSClient.prototype as any).config = { region: originalRegion };
    }
  }
}

Deno.test("inspect - records an actionable ERROR insight with deprecation detail", async () => {
  await withMockEks({
    region: "us-east-1",
    listInsights: () => ({
      insights: [
        {
          id: "ins-1",
          name: "Deprecated APIs removed in v1.29",
          category: "UPGRADE_READINESS",
          kubernetesVersion: "1.29",
          insightStatus: { status: "ERROR", reason: "deprecated APIs in use" },
          description: "Some APIs are removed in 1.29",
          lastRefreshTime: new Date("2026-10-23T00:00:00Z"),
          lastTransitionTime: new Date("2026-10-23T00:00:00Z"),
        },
      ],
    }),
    describeInsight: () => ({
      insight: {
        recommendation: "Migrate off the removed API versions.",
        categorySpecificSummary: {
          deprecationDetails: [
            {
              usage: "flowcontrol.apiserver.k8s.io/v1beta2 FlowSchema",
              replacedWith: "flowcontrol.apiserver.k8s.io/v1",
              stopServingVersion: "1.29",
              startServingReplacementVersion: "1.26",
              clientStats: [
                {
                  userAgent: "kubectl/v1.27.3",
                  numberOfRequestsLast30Days: 42,
                  lastRequestTime: new Date("2026-10-22T00:00:00Z"),
                },
              ],
            },
          ],
        },
      },
    }),
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { region: "us-east-1" },
      methodName: "inspect",
    });

    const result = await model.methods.inspect.execute(
      { clusters: ["prod-use1"], allClusters: false },
      context as Any,
    );
    assertEquals(result.dataHandles.length, 1);

    const data = getWrittenResources()[0].data as Any;
    assertEquals(data.cluster, "prod-use1");
    assertEquals(data.ok, true);
    assertEquals(data.errorCount, 1);
    assertEquals(data.warningCount, 0);
    assertEquals(data.actionableCount, 1);
    assertEquals(data.insights[0].status, "ERROR");
    assertEquals(data.insights[0].recommendation.length > 0, true);
    assertEquals(
      data.insights[0].deprecationDetails[0].clients[0].userAgent,
      "kubectl/v1.27.3",
    );
    assertEquals(
      data.insights[0].deprecationDetails[0].clients[0].requestsLast30Days,
      42,
    );
  });
});

Deno.test("inspect - a cluster that fails to inspect is recorded ok=false and does not abort", async () => {
  await withMockEks({
    region: "us-east-1",
    listInsights: (input) => {
      if (input.clusterName === "broken") {
        throw new Error("AccessDenied");
      }
      return { insights: [] };
    },
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { region: "us-east-1" },
      methodName: "inspect",
    });
    // The harness logger only stubs .info; the failure path also logs .warning.
    const ctx = context as Any;
    ctx.logger = {
      info() {},
      warning() {},
      error() {},
    };

    const result = await model.methods.inspect.execute(
      { clusters: ["broken", "healthy"], allClusters: false },
      ctx as Any,
    );
    assertEquals(result.dataHandles.length, 2);

    const resources = getWrittenResources();
    const broken = (resources.map((r) => r.data as Any)).find((d) =>
      d.cluster === "broken"
    );
    const healthy = (resources.map((r) => r.data as Any)).find((d) =>
      d.cluster === "healthy"
    );

    assertEquals(broken.ok, false);
    assertEquals(broken.error.includes("AccessDenied"), true);
    assertEquals(healthy.ok, true);
    assertEquals(healthy.insights.length, 0);
  });
});

Deno.test("inspect - no clusters selected throws", async () => {
  await withMockEks({ region: "us-east-1" }, async () => {
    const { context } = createModelTestContext({
      globalArgs: { region: "us-east-1" },
      methodName: "inspect",
    });

    let threw = false;
    try {
      await model.methods.inspect.execute(
        { clusters: [], allClusters: false },
        context as Any,
      );
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("no clusters selected"), true);
    }
    assertEquals(threw, true);
  });
});
