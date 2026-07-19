/**
 * Unit tests for @twonines/k8s-fleet extension model.
 * Validates fleet health logic against mocked kubernetes API responses.
 */
// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertExists } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";
import * as k8s from "npm:@kubernetes/client-node@1.0.0";

// ---------------------------------------------------------------------------
// Test helpers — mock KubeConfig and API clients
// ---------------------------------------------------------------------------

/**
 * Patch KubeConfig to return our fake contexts without reading disk.
 * We monkey-patch the prototype methods for the duration of each test.
 */
function withMockKubeConfig(
  opts: {
    contexts: Array<{
      name: string;
      cluster?: string;
      server?: string;
      user?: string;
      namespace?: string;
    }>;
    currentContext?: string;
    /** If set, listNode/listPodForAllNamespaces will throw for these contexts */
    unreachableContexts?: string[];
    /** Per-context node data */
    nodes?: Record<string, Array<{ name: string; ready: boolean }>>;
    /** Per-context pod summary overrides */
    pods?: Record<
      string,
      Array<{
        name: string;
        phase: string;
        restarts?: number;
        crashLoop?: boolean;
      }>
    >;
  },
  fn: () => Promise<void>,
): Promise<void> {
  const originalLoadFromDefault = k8s.KubeConfig.prototype.loadFromDefault;
  const originalLoadFromFile = k8s.KubeConfig.prototype.loadFromFile;
  const originalLoadFromString = k8s.KubeConfig.prototype.loadFromString;
  const originalGetContexts = k8s.KubeConfig.prototype.getContexts;
  const originalGetCurrentContext = k8s.KubeConfig.prototype.getCurrentContext;
  const originalSetCurrentContext = k8s.KubeConfig.prototype.setCurrentContext;
  const originalGetCluster = k8s.KubeConfig.prototype.getCluster;
  const originalGetUser = k8s.KubeConfig.prototype.getUser;
  const originalMakeApiClient = k8s.KubeConfig.prototype.makeApiClient;
  const originalExportConfig = k8s.KubeConfig.prototype.exportConfig;

  const currentCtx = opts.currentContext || opts.contexts[0]?.name || "";
  const unreachable = new Set(opts.unreachableContexts || []);

  // Track which context is set per instance
  const instanceContexts = new WeakMap<k8s.KubeConfig, string>();

  k8s.KubeConfig.prototype.loadFromDefault = function () {
    instanceContexts.set(this, currentCtx);
  };
  k8s.KubeConfig.prototype.loadFromFile = function () {
    instanceContexts.set(this, currentCtx);
  };
  k8s.KubeConfig.prototype.loadFromString = function () {
    instanceContexts.set(this, currentCtx);
  };
  // deno-lint-ignore no-explicit-any
  k8s.KubeConfig.prototype.exportConfig = function (): any {
    return { contexts: [], clusters: [], users: [] };
  };
  k8s.KubeConfig.prototype.getContexts = function () {
    return opts.contexts.map((c) => ({
      name: c.name,
      cluster: c.cluster || c.name,
      user: c.user || "admin",
      namespace: c.namespace,
    }));
  };
  k8s.KubeConfig.prototype.getCurrentContext = function () {
    return instanceContexts.get(this) || currentCtx;
  };
  k8s.KubeConfig.prototype.setCurrentContext = function (ctx: string) {
    instanceContexts.set(this, ctx);
  };
  // deno-lint-ignore no-explicit-any
  k8s.KubeConfig.prototype.getCluster = function (name: string): any {
    const c = opts.contexts.find((ctx) => (ctx.cluster || ctx.name) === name);
    return c
      ? {
        name: c.cluster || c.name,
        server: c.server || `https://${c.name}:6443`,
      }
      : null;
  };
  k8s.KubeConfig.prototype.getUser = function (name: string) {
    return { name };
  };

  // deno-lint-ignore no-explicit-any
  k8s.KubeConfig.prototype.makeApiClient = function (_apiType: any): any {
    const ctxName = instanceContexts.get(this) || currentCtx;

    return {
      listNode: (_opts?: unknown) => {
        if (unreachable.has(ctxName)) {
          return Promise.reject(new Error(`connect ECONNREFUSED ${ctxName}`));
        }
        const nodeData = opts.nodes?.[ctxName] || [
          { name: "node-1", ready: true },
        ];
        return Promise.resolve({
          items: nodeData.map((n) => ({
            metadata: { name: n.name },
            status: {
              conditions: [
                { type: "Ready", status: n.ready ? "True" : "False" },
                { type: "MemoryPressure", status: "False" },
                { type: "DiskPressure", status: "False" },
                { type: "PIDPressure", status: "False" },
              ],
            },
          })),
        });
      },
      listPodForAllNamespaces: (_opts?: unknown) => {
        if (unreachable.has(ctxName)) {
          return Promise.reject(new Error(`connect ECONNREFUSED ${ctxName}`));
        }
        const podData = opts.pods?.[ctxName] || [
          { name: "pod-1", phase: "Running", restarts: 0 },
        ];
        return Promise.resolve({
          items: podData.map((p) => ({
            metadata: { name: p.name, namespace: "default" },
            status: {
              phase: p.phase,
              containerStatuses: [
                {
                  name: "main",
                  restartCount: p.restarts || 0,
                  state: p.crashLoop
                    ? { waiting: { reason: "CrashLoopBackOff" } }
                    : { running: {} },
                },
              ],
            },
          })),
        });
      },
    };
  };

  return fn().finally(() => {
    k8s.KubeConfig.prototype.loadFromDefault = originalLoadFromDefault;
    k8s.KubeConfig.prototype.loadFromFile = originalLoadFromFile;
    k8s.KubeConfig.prototype.loadFromString = originalLoadFromString;
    k8s.KubeConfig.prototype.getContexts = originalGetContexts;
    k8s.KubeConfig.prototype.getCurrentContext = originalGetCurrentContext;
    k8s.KubeConfig.prototype.setCurrentContext = originalSetCurrentContext;
    k8s.KubeConfig.prototype.getCluster = originalGetCluster;
    k8s.KubeConfig.prototype.getUser = originalGetUser;
    k8s.KubeConfig.prototype.makeApiClient = originalMakeApiClient;
    k8s.KubeConfig.prototype.exportConfig = originalExportConfig;
  });
}

// ---------------------------------------------------------------------------
// Tests: contexts method
// ---------------------------------------------------------------------------

Deno.test("contexts - lists all available contexts", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "prod-us-east-1", server: "https://prod-east.example.com" },
        { name: "prod-us-west-2", server: "https://prod-west.example.com" },
        { name: "staging", server: "https://staging.example.com" },
      ],
      currentContext: "prod-us-east-1",
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "contexts",
      });

      const result = await model.methods.contexts.execute({}, context);
      assertEquals(result.dataHandles.length, 3);

      const resources = getWrittenResources();
      assertEquals(resources.length, 3);

      // deno-lint-ignore no-explicit-any
      const first = resources[0].data as any;
      assertEquals(first.name, "prod-us-east-1");
      assertEquals(first.isCurrentContext, true);
      assertEquals(first.reachable, true);
    },
  );
});

Deno.test("contexts - marks unreachable clusters", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "healthy" },
        { name: "dead" },
      ],
      unreachableContexts: ["dead"],
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "contexts",
      });

      await model.methods.contexts.execute({}, context);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const healthy = resources.find((r: any) => r.data.name === "healthy");
      // deno-lint-ignore no-explicit-any
      const dead = resources.find((r: any) => r.data.name === "dead");

      // deno-lint-ignore no-explicit-any
      assertEquals((healthy as any).data.reachable, true);
      // deno-lint-ignore no-explicit-any
      assertEquals((dead as any).data.reachable, false);
      // deno-lint-ignore no-explicit-any
      assertExists((dead as any).data.error);
    },
  );
});

Deno.test("contexts - respects contexts filter", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "prod" },
        { name: "staging" },
        { name: "dev" },
      ],
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { contexts: ["prod", "staging"] },
        methodName: "contexts",
      });

      const result = await model.methods.contexts.execute({}, context);
      assertEquals(result.dataHandles.length, 2);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const names = resources.map((r: any) => r.data.name).sort();
      assertEquals(names, ["prod", "staging"]);
    },
  );
});

// ---------------------------------------------------------------------------
// Tests: health method
// ---------------------------------------------------------------------------

Deno.test("health - reports node and pod status per cluster", async () => {
  await withMockKubeConfig(
    {
      contexts: [{ name: "prod" }],
      nodes: {
        prod: [
          { name: "node-1", ready: true },
          { name: "node-2", ready: true },
          { name: "node-3", ready: false },
        ],
      },
      pods: {
        prod: [
          { name: "app-1", phase: "Running" },
          { name: "app-2", phase: "Running" },
          { name: "job-1", phase: "Succeeded" },
          { name: "broken", phase: "Failed" },
        ],
      },
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "health",
      });

      const result = await model.methods.health.execute({}, context);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const data = resources[0].data as any;
      assertEquals(data.context, "prod");
      assertEquals(data.reachable, true);
      assertEquals(data.nodes.total, 3);
      assertEquals(data.nodes.ready, 2);
      assertEquals(data.nodes.notReady, 1);
      assertEquals(data.pods.total, 4);
      assertEquals(data.pods.running, 2);
      assertEquals(data.pods.succeeded, 1);
      assertEquals(data.pods.failed, 1);
    },
  );
});

Deno.test("health - unreachable cluster reports error", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "healthy" },
        { name: "dead" },
      ],
      unreachableContexts: ["dead"],
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "health",
      });

      const result = await model.methods.health.execute({}, context);
      assertEquals(result.dataHandles.length, 2);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const deadCluster = resources.find((r: any) => r.data.context === "dead");
      // deno-lint-ignore no-explicit-any
      assertEquals((deadCluster as any).data.reachable, false);
      // deno-lint-ignore no-explicit-any
      assertExists((deadCluster as any).data.error);
    },
  );
});

// ---------------------------------------------------------------------------
// Tests: summary method
// ---------------------------------------------------------------------------

Deno.test("summary - aggregates across clusters", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "us-east-1" },
        { name: "us-west-2" },
      ],
      nodes: {
        "us-east-1": [
          { name: "node-1", ready: true },
          { name: "node-2", ready: true },
        ],
        "us-west-2": [
          { name: "node-1", ready: true },
          { name: "node-2", ready: false },
        ],
      },
      pods: {
        "us-east-1": [
          { name: "app-1", phase: "Running" },
          { name: "app-2", phase: "Running" },
        ],
        "us-west-2": [
          { name: "app-1", phase: "Running" },
          { name: "crash", phase: "Running", crashLoop: true, restarts: 15 },
        ],
      },
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "summary",
      });

      const result = await model.methods.summary.execute({}, context);
      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const data = resources[0].data as any;
      assertEquals(data.totalContexts, 2);
      assertEquals(data.reachable, 2);
      assertEquals(data.unreachable, 0);
      assertEquals(data.totalNodes, 4);
      assertEquals(data.nodesReady, 3);
      assertEquals(data.nodesNotReady, 1);
      assertEquals(data.totalPods, 4);
      assertEquals(data.totalRestarts, 15);
      // us-west-2 has a not-ready node AND a crashloop pod
      assertEquals(data.unhealthyClusters, ["us-west-2"]);
    },
  );
});

Deno.test("summary - handles mixed reachable and unreachable", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "prod" },
        { name: "old-cluster" },
        { name: "staging" },
      ],
      unreachableContexts: ["old-cluster"],
      nodes: {
        prod: [{ name: "n1", ready: true }],
        staging: [{ name: "n1", ready: true }],
      },
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "summary",
      });

      await model.methods.summary.execute({}, context);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const data = resources[0].data as any;
      assertEquals(data.totalContexts, 3);
      assertEquals(data.reachable, 2);
      assertEquals(data.unreachable, 1);
      assertEquals(data.unreachableClusters, ["old-cluster"]);
      assertEquals(data.totalNodes, 2);
    },
  );
});

Deno.test("summary - all clusters unreachable", async () => {
  await withMockKubeConfig(
    {
      contexts: [
        { name: "dead-1" },
        { name: "dead-2" },
      ],
      unreachableContexts: ["dead-1", "dead-2"],
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "summary",
      });

      await model.methods.summary.execute({}, context);

      const resources = getWrittenResources();
      // deno-lint-ignore no-explicit-any
      const data = resources[0].data as any;
      assertEquals(data.totalContexts, 2);
      assertEquals(data.reachable, 0);
      assertEquals(data.unreachable, 2);
      assertEquals(data.totalNodes, 0);
      assertEquals(data.totalPods, 0);
      assertEquals(data.unreachableClusters.sort(), ["dead-1", "dead-2"]);
    },
  );
});
