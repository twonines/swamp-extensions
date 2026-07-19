/**
 * Fleet-wide Kubernetes health model.
 *
 * Iterates all kubeconfig contexts (or a specified subset) and produces
 * per-cluster health snapshots plus an aggregated fleet summary.
 * Best-effort: unreachable clusters are reported as degraded, not fatal.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";
import * as k8s from "npm:@kubernetes/client-node@1.0.0";

// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  kubeconfig: z.string().optional().describe(
    "Path to kubeconfig file. Defaults to ~/.kube/config.",
  ),
  contexts: z.array(z.string()).optional().describe(
    "Limit to these context names. If omitted, all contexts are used.",
  ),
  timeout: z.number().optional().default(10).describe(
    "Per-context API timeout in seconds (default: 10).",
  ),
});

const ContextInfoSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  user: z.string(),
  namespace: z.string(),
  server: z.string(),
  isCurrentContext: z.boolean(),
  reachable: z.boolean(),
  error: z.string().optional(),
  queriedAt: z.string(),
}).passthrough();

const ClusterHealthSchema = z.object({
  context: z.string(),
  server: z.string(),
  reachable: z.boolean(),
  error: z.string().optional(),
  nodes: z.object({
    total: z.number(),
    ready: z.number(),
    notReady: z.number(),
    conditions: z.array(z.object({
      name: z.string(),
      ready: z.boolean(),
      memoryPressure: z.boolean(),
      diskPressure: z.boolean(),
      pidPressure: z.boolean(),
    })),
  }).optional(),
  pods: z.object({
    total: z.number(),
    running: z.number(),
    pending: z.number(),
    failed: z.number(),
    succeeded: z.number(),
    unknown: z.number(),
    crashLoopBackOff: z.number(),
    totalRestarts: z.number(),
  }).optional(),
  queriedAt: z.string(),
}).passthrough();

const FleetSummarySchema = z.object({
  totalContexts: z.number(),
  reachable: z.number(),
  unreachable: z.number(),
  totalNodes: z.number(),
  nodesReady: z.number(),
  nodesNotReady: z.number(),
  totalPods: z.number(),
  podsHealthy: z.number(),
  podsUnhealthy: z.number(),
  totalRestarts: z.number(),
  unhealthyClusters: z.array(z.string()),
  unreachableClusters: z.array(z.string()),
  queriedAt: z.string(),
}).passthrough();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface KubeContext {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  server: string;
  isCurrentContext: boolean;
}

function loadContexts(globalArgs: z.infer<typeof GlobalArgsSchema>): {
  kc: k8s.KubeConfig;
  contexts: KubeContext[];
} {
  const kc = new k8s.KubeConfig();

  if (globalArgs.kubeconfig) {
    kc.loadFromFile(globalArgs.kubeconfig);
  } else {
    kc.loadFromDefault();
  }

  const currentContext = kc.getCurrentContext();
  let ctxList = kc.getContexts().map((ctx) => {
    const cluster = kc.getCluster(ctx.cluster);
    const user = kc.getUser(ctx.user);
    return {
      name: ctx.name,
      cluster: cluster?.name || ctx.cluster || "",
      user: user?.name || ctx.user || "",
      namespace: ctx.namespace || "default",
      server: cluster?.server || "",
      isCurrentContext: ctx.name === currentContext,
    };
  });

  // Filter to requested contexts if specified
  if (globalArgs.contexts && globalArgs.contexts.length > 0) {
    const allowed = new Set(globalArgs.contexts);
    ctxList = ctxList.filter((c) => allowed.has(c.name));
  }

  return { kc, contexts: ctxList };
}

function buildClientForContext(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
  contextName: string,
): { coreApi: k8s.CoreV1Api } {
  const kc = new k8s.KubeConfig();
  if (globalArgs.kubeconfig) {
    kc.loadFromFile(globalArgs.kubeconfig);
  } else {
    kc.loadFromDefault();
  }
  kc.setCurrentContext(contextName);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  return { coreApi };
}

interface NodeHealth {
  name: string;
  ready: boolean;
  memoryPressure: boolean;
  diskPressure: boolean;
  pidPressure: boolean;
}

function assessNodeConditions(node: k8s.V1Node): NodeHealth {
  const conditions = node.status?.conditions || [];
  const cond = (type: string) =>
    conditions.find((c) => c.type === type)?.status === "True";

  return {
    name: node.metadata?.name || "unknown",
    ready: cond("Ready"),
    memoryPressure: cond("MemoryPressure"),
    diskPressure: cond("DiskPressure"),
    pidPressure: cond("PIDPressure"),
  };
}

interface PodSummary {
  total: number;
  running: number;
  pending: number;
  failed: number;
  succeeded: number;
  unknown: number;
  crashLoopBackOff: number;
  totalRestarts: number;
}

function summarizePods(pods: k8s.V1Pod[]): PodSummary {
  const summary: PodSummary = {
    total: pods.length,
    running: 0,
    pending: 0,
    failed: 0,
    succeeded: 0,
    unknown: 0,
    crashLoopBackOff: 0,
    totalRestarts: 0,
  };

  for (const pod of pods) {
    const phase = pod.status?.phase || "Unknown";
    switch (phase) {
      case "Running":
        summary.running++;
        break;
      case "Pending":
        summary.pending++;
        break;
      case "Failed":
        summary.failed++;
        break;
      case "Succeeded":
        summary.succeeded++;
        break;
      default:
        summary.unknown++;
    }

    const containers = pod.status?.containerStatuses || [];
    for (const cs of containers) {
      summary.totalRestarts += cs.restartCount || 0;
      if (cs.state?.waiting?.reason === "CrashLoopBackOff") {
        summary.crashLoopBackOff++;
      }
    }
  }

  return summary;
}

async function probeCluster(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
  contextName: string,
  timeoutMs: number,
): Promise<{
  reachable: boolean;
  error?: string;
  nodes?: NodeHealth[];
  pods?: PodSummary;
}> {
  try {
    const { coreApi } = buildClientForContext(globalArgs, contextName);

    // Use AbortController for timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Fetch nodes
      const nodesResp = await coreApi.listNode(
        { timeoutSeconds: Math.ceil(timeoutMs / 1000) },
      );
      const nodes = (nodesResp.items || []).map(assessNodeConditions);

      // Fetch all pods across all namespaces
      const podsResp = await coreApi.listPodForAllNamespaces(
        { timeoutSeconds: Math.ceil(timeoutMs / 1000) },
      );
      const pods = summarizePods(podsResp.items || []);

      clearTimeout(timer);
      return { reachable: true, nodes, pods };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: msg };
  }
}

function sanitizeInstanceName(name: string): string {
  return name
    .replace(/\.\./g, "--")
    .replace(/[/\\:]/g, "-")
    .replace(/\0/g, "");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Fleet-wide Kubernetes health model.
 *
 * Iterates all kubeconfig contexts (or a filtered subset) and produces
 * per-cluster health snapshots plus an aggregated fleet summary.
 * Best-effort: unreachable clusters are reported as degraded, not fatal.
 *
 * @example
 * ```ts
 * import { model } from "./mod.ts";
 * // model.type === "@twonines/k8s-fleet"
 * // model.methods: contexts, health, summary
 * ```
 */
export const model = {
  type: "@twonines/k8s-fleet",
  version: "2026.07.19.2",
  description:
    "Fleet-wide Kubernetes health — iterates all kubeconfig contexts and " +
    "produces per-cluster health snapshots plus an aggregated fleet summary. " +
    "Best-effort: unreachable clusters are reported, not fatal.",
  globalArguments: GlobalArgsSchema,
  resources: {
    context: {
      description: "Kubeconfig context metadata with reachability status",
      schema: ContextInfoSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    clusterHealth: {
      description:
        "Per-cluster health snapshot: node conditions, pod phase summary",
      schema: ClusterHealthSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    fleetSummary: {
      description: "Aggregated fleet health across all probed clusters",
      schema: FleetSummarySchema,
      lifetime: "30m" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    contexts: {
      description:
        "List all kubeconfig contexts with cluster/user/namespace info " +
        "and a quick reachability check.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const ga = context.globalArgs;
        const { contexts } = loadContexts(ga);

        context.logger.info("Probing {count} contexts", {
          count: contexts.length,
        });

        // Probe contexts in parallel (batched)
        const batchSize = 10;
        const probeResults: Array<{
          ctx: KubeContext;
          reachable: boolean;
          error: string | undefined;
        }> = [];
        for (let i = 0; i < contexts.length; i += batchSize) {
          const batch = contexts.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (ctx) => {
              let reachable = true;
              let error: string | undefined;
              try {
                const { coreApi } = buildClientForContext(ga, ctx.name);
                await coreApi.listNode({
                  timeoutSeconds: Math.min(5, ga.timeout || 10),
                });
              } catch (err) {
                reachable = false;
                error = err instanceof Error ? err.message : String(err);
              }
              return { ctx, reachable, error };
            }),
          );
          probeResults.push(...batchResults);
        }

        const handles = [];
        for (const { ctx, reachable, error } of probeResults) {
          const data = {
            ...ctx,
            reachable,
            error,
            queriedAt: new Date().toISOString(),
          };

          const handle = await context.writeResource(
            "context",
            sanitizeInstanceName(ctx.name),
            data,
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    health: {
      description:
        "Probe each context for node conditions, pod phase counts, and " +
        "resource pressure. Unreachable clusters are marked with their error.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const ga = context.globalArgs;
        const { contexts } = loadContexts(ga);
        const timeoutMs = (ga.timeout || 10) * 1000;

        context.logger.info(
          "Running fleet health check across {count} contexts",
          {
            count: contexts.length,
          },
        );

        // Probe all contexts in parallel (batched)
        const batchSize = 10;
        const probeResults: Array<{
          ctx: KubeContext;
          result: Awaited<ReturnType<typeof probeCluster>>;
        }> = [];
        for (let i = 0; i < contexts.length; i += batchSize) {
          const batch = contexts.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (ctx) => ({
              ctx,
              result: await probeCluster(ga, ctx.name, timeoutMs),
            })),
          );
          probeResults.push(...batchResults);
        }

        const handles = [];
        for (const { ctx, result } of probeResults) {
          const data: Record<string, unknown> = {
            context: ctx.name,
            server: ctx.server,
            reachable: result.reachable,
            queriedAt: new Date().toISOString(),
          };

          if (result.error) {
            data.error = result.error;
          }

          if (result.nodes) {
            data.nodes = {
              total: result.nodes.length,
              ready: result.nodes.filter((n) => n.ready).length,
              notReady: result.nodes.filter((n) => !n.ready).length,
              conditions: result.nodes,
            };
          }

          if (result.pods) {
            data.pods = result.pods;
          }

          const handle = await context.writeResource(
            "clusterHealth",
            sanitizeInstanceName(ctx.name),
            data,
          );
          handles.push(handle);

          if (result.reachable) {
            context.logger.info(
              "  {ctx}: {ready}/{total} nodes ready, {pods} pods",
              {
                ctx: ctx.name,
                ready: result.nodes?.filter((n) => n.ready).length ?? 0,
                total: result.nodes?.length ?? 0,
                pods: result.pods?.total ?? 0,
              },
            );
          } else {
            context.logger.warn("  {ctx}: unreachable — {error}", {
              ctx: ctx.name,
              error: result.error || "unknown",
            });
          }
        }

        return { dataHandles: handles };
      },
    },

    summary: {
      description:
        "Run health checks then aggregate into a single fleet summary: " +
        "total clusters, nodes, pods, and lists of unhealthy/unreachable clusters.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const ga = context.globalArgs;
        const { contexts } = loadContexts(ga);
        const timeoutMs = (ga.timeout || 10) * 1000;

        context.logger.info(
          "Generating fleet summary across {count} contexts",
          {
            count: contexts.length,
          },
        );

        let totalNodes = 0;
        let nodesReady = 0;
        let nodesNotReady = 0;
        let totalPods = 0;
        let podsHealthy = 0;
        let podsUnhealthy = 0;
        let totalRestarts = 0;
        const unhealthyClusters: string[] = [];
        const unreachableClusters: string[] = [];
        let reachableCount = 0;

        // Probe all contexts in parallel (batched to avoid overwhelming STS)
        const batchSize = 10;
        const probeResults: Array<{
          ctx: KubeContext;
          result: Awaited<ReturnType<typeof probeCluster>>;
        }> = [];
        for (let i = 0; i < contexts.length; i += batchSize) {
          const batch = contexts.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (ctx) => ({
              ctx,
              result: await probeCluster(ga, ctx.name, timeoutMs),
            })),
          );
          probeResults.push(...batchResults);
        }

        for (const { ctx, result } of probeResults) {
          if (!result.reachable) {
            unreachableClusters.push(ctx.name);
            continue;
          }

          reachableCount++;

          if (result.nodes) {
            const ready = result.nodes.filter((n) => n.ready).length;
            const notReady = result.nodes.length - ready;
            totalNodes += result.nodes.length;
            nodesReady += ready;
            nodesNotReady += notReady;

            if (notReady > 0) {
              unhealthyClusters.push(ctx.name);
            }
          }

          if (result.pods) {
            totalPods += result.pods.total;
            podsHealthy += result.pods.running + result.pods.succeeded;
            podsUnhealthy += result.pods.failed + result.pods.unknown +
              result.pods.crashLoopBackOff;
            totalRestarts += result.pods.totalRestarts;

            // Also flag clusters with CrashLoopBackOff pods as unhealthy
            if (
              result.pods.crashLoopBackOff > 0 &&
              !unhealthyClusters.includes(ctx.name)
            ) {
              unhealthyClusters.push(ctx.name);
            }
          }
        }

        const summaryData = {
          totalContexts: contexts.length,
          reachable: reachableCount,
          unreachable: unreachableClusters.length,
          totalNodes,
          nodesReady,
          nodesNotReady,
          totalPods,
          podsHealthy,
          podsUnhealthy,
          totalRestarts,
          unhealthyClusters,
          unreachableClusters,
          queriedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "fleetSummary",
          "fleet-summary",
          summaryData,
        );

        context.logger.info(
          "Fleet: {reachable}/{total} reachable, {nodes} nodes ({ready} ready), {pods} pods",
          {
            reachable: reachableCount,
            total: contexts.length,
            nodes: totalNodes,
            ready: nodesReady,
            pods: totalPods,
          },
        );

        if (unreachableClusters.length > 0) {
          context.logger.warn("Unreachable: {clusters}", {
            clusters: unreachableClusters.join(", "),
          });
        }
        if (unhealthyClusters.length > 0) {
          context.logger.warn("Unhealthy: {clusters}", {
            clusters: unhealthyClusters.join(", "),
          });
        }

        return { dataHandles: [handle] };
      },
    },
  },
};
