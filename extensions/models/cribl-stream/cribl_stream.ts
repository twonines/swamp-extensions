/**
 * Cribl Stream Cloud — read-only integration for troubleshooting sources,
 * routes, pipelines, destinations, event capture, lookups, knowledge
 * objects, worker-group logs/notifications, and the public status page,
 * via the Cribl Cloud REST API.
 *
 * Authentication uses OAuth2 client_credentials grant against Cribl Cloud.
 * All methods are read-only observation/sync operations (except
 * check_status_page/list_status_page_incidents, which are unauthenticated
 * calls to Cribl's public status.cribl.cloud).
 *
 * Forked from @figura/cribl-stream (https://github.com/ftveronezzi/swamp-extensions)
 * with 8 additional methods: list_notifications, list_log_files,
 * get_log_lines, check_status_page, list_status_page_incidents, list_workers,
 * get_node_input_status, get_node_output_status. Also proposed upstream:
 * https://github.com/ftveronezzi/swamp-extensions/pull/2
 *
 * list_sources/get_source/health read a leader-aggregated view of a worker
 * group. On Cribl Cloud that aggregated view has been observed to report
 * numRequests: 0 for a source that is, per-node, actively processing tens of
 * thousands of events -- list_workers + get_node_input_status/
 * get_node_output_status bypass the aggregation and read one node directly.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .describe(
      "Cribl Cloud base URL (e.g. https://main-<org>.cribl.cloud)",
    ),
  clientId: z.string().meta({ sensitive: true }).describe(
    "Cribl API Client ID",
  ),
  clientSecret: z
    .string()
    .meta({ sensitive: true })
    .describe("Cribl API Client Secret"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Resource output schemas ---

const SourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  disabled: z.boolean(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
});

const SourcesOutputSchema = z.object({
  workerGroup: z.string(),
  sources: z.array(SourceSchema),
  totalCount: z.number(),
  fetchedAt: z.string(),
});

const SourceDetailSchema = z.object({
  workerGroup: z.string(),
  source: SourceSchema,
  fetchedAt: z.string(),
});

const RouteSchema = z.object({
  id: z.string(),
  name: z.string(),
  filter: z.string(),
  pipeline: z.string().optional(),
  output: z.string().optional(),
  disabled: z.boolean(),
  description: z.string().optional(),
  groups: z.record(z.unknown()).optional(),
});

const RoutesOutputSchema = z.object({
  workerGroup: z.string(),
  routes: z.array(RouteSchema),
  totalCount: z.number(),
  enabledCount: z.number(),
  disabledCount: z.number(),
  fetchedAt: z.string(),
});

const PipelineFunctionSchema = z.object({
  id: z.string(),
  filter: z.string().optional(),
  disabled: z.boolean().optional(),
  description: z.string().optional(),
  conf: z.record(z.unknown()).optional(),
});

const PipelineSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
  functions: z.array(PipelineFunctionSchema).optional(),
});

const PipelinesOutputSchema = z.object({
  workerGroup: z.string(),
  pipelines: z.array(PipelineSchema),
  totalCount: z.number(),
  fetchedAt: z.string(),
});

const PipelineDetailSchema = z.object({
  workerGroup: z.string(),
  pipeline: PipelineSchema,
  fetchedAt: z.string(),
});

const DestinationSchema = z.object({
  id: z.string(),
  type: z.string(),
  disabled: z.boolean(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
});

const DestinationsOutputSchema = z.object({
  workerGroup: z.string(),
  destinations: z.array(DestinationSchema),
  totalCount: z.number(),
  fetchedAt: z.string(),
});

const DestinationDetailSchema = z.object({
  workerGroup: z.string(),
  destination: DestinationSchema,
  fetchedAt: z.string(),
});

const CaptureEventSchema = z.object({
  _raw: z.string().optional(),
  _time: z.unknown().optional(),
  fields: z.record(z.unknown()),
});

const CaptureOutputSchema = z.object({
  workerGroup: z.string(),
  captureId: z.string(),
  filter: z.string().optional(),
  events: z.array(CaptureEventSchema),
  eventCount: z.number(),
  fetchedAt: z.string(),
});

const LookupSchema = z.object({
  id: z.string(),
  fileInfo: z.record(z.unknown()).optional(),
  size: z.number().optional(),
  description: z.string().optional(),
});

const LookupsOutputSchema = z.object({
  workerGroup: z.string(),
  lookups: z.array(LookupSchema),
  totalCount: z.number(),
  fetchedAt: z.string(),
});

const KnowledgeObjectSchema = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
});

const KnowledgeOutputSchema = z.object({
  workerGroup: z.string(),
  objectType: z.string(),
  objects: z.array(KnowledgeObjectSchema),
  totalCount: z.number(),
  fetchedAt: z.string(),
});

const HealthComponentSchema = z.object({
  type: z.string(),
  id: z.string(),
  status: z.enum(["healthy", "warning", "error", "disabled"]),
  message: z.string().optional(),
});

const HealthOutputSchema = z.object({
  workerGroup: z.string(),
  overall: z.enum(["healthy", "warning", "error"]),
  components: z.array(HealthComponentSchema),
  sourcesTotal: z.number(),
  destinationsTotal: z.number(),
  pipelinesTotal: z.number(),
  routesTotal: z.number(),
  fetchedAt: z.string(),
});

const NotificationsOutputSchema = z.object({
  workerGroup: z.string(),
  items: z.array(z.record(z.unknown())),
  count: z.number(),
  fetchedAt: z.string(),
});

const LogFilesOutputSchema = z.object({
  workerGroup: z.string(),
  files: z.array(z.record(z.unknown())),
  fetchedAt: z.string(),
});

const LogLinesOutputSchema = z.object({
  workerGroup: z.string(),
  fileId: z.string(),
  filter: z.string().optional(),
  events: z.array(z.record(z.unknown())),
  endOfResults: z.boolean().optional(),
  fetchedAt: z.string(),
});

const StatusPageOutputSchema = z.object({
  indicator: z.string(),
  description: z.string(),
  unresolvedIncidents: z.array(z.record(z.unknown())),
  activeMaintenances: z.array(z.record(z.unknown())),
  fetchedAt: z.string(),
});

const StatusPageIncidentsOutputSchema = z.object({
  page: z.number(),
  incidents: z.array(z.record(z.unknown())),
  count: z.number(),
  fetchedAt: z.string(),
});

const WorkersOutputSchema = z.object({
  workers: z.array(z.record(z.unknown())),
  count: z.number(),
  fetchedAt: z.string(),
});

const NodeInputStatusOutputSchema = z.object({
  nodeId: z.string(),
  sourceId: z.string(),
  status: z.record(z.unknown()).nullable(),
  fetchedAt: z.string(),
});

const NodeOutputStatusOutputSchema = z.object({
  nodeId: z.string(),
  destinationId: z.string(),
  status: z.record(z.unknown()).nullable(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

interface ModelContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warning: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
}

/** Cached bearer token with expiry. */
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Obtain a bearer token via OAuth2 client_credentials grant. */
async function getAccessToken(
  _baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.token;
  }

  // Cribl Cloud uses a centralized identity service for OAuth
  const tokenUrl = "https://login.cribl.cloud/oauth/token";
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: "https://api.cribl.cloud",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "[unreadable]");
    throw new Error(`Cribl auth failed (${resp.status}): ${body}`);
  }

  const data = await resp.json() as {
    access_token: string;
    expires_in?: number;
  };
  const expiresIn = (data.expires_in ?? 3600) * 1000;
  tokenCache = { token: data.access_token, expiresAt: now + expiresIn };
  return data.access_token;
}

/** Make an authenticated GET request to the Cribl API. */
async function criblGet(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  path: string,
): Promise<unknown> {
  const token = await getAccessToken(baseUrl, clientId, clientSecret);
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "[unreadable]");
    throw new Error(`Cribl API ${resp.status} ${path}: ${body}`);
  }
  return resp.json();
}

/** Make an authenticated POST request to the Cribl API. */
async function criblPost(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken(baseUrl, clientId, clientSecret);
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const body2 = await resp.text().catch(() => "[unreadable]");
    throw new Error(`Cribl API POST ${resp.status} ${path}: ${body2}`);
  }
  return resp.json();
}

function workerPath(workerGroup: string, subpath: string): string {
  return `/api/v1/m/${encodeURIComponent(workerGroup)}${subpath}`;
}

/** Base URL for Cribl's public, unauthenticated status page (statuspage.io). */
const CRIBL_STATUSPAGE_BASE = "https://cribl.statuspage.io/api/v2";

function instanceKey(prefix: string, workerGroup: string, id?: string): string {
  const base = `${prefix}-${workerGroup}`;
  return id ? `${base}-${id}` : base;
}

// =============================================================================
// Model Definition
// =============================================================================

/** Cribl Stream Cloud read-only integration for troubleshooting. */
export const model = {
  type: "@twonines/cribl-stream",
  version: "2026.08.27.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    sources: {
      description: "Input sources configured in a worker group",
      schema: SourcesOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    source_detail: {
      description: "Detailed config for a specific source",
      schema: SourceDetailSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    routes: {
      description: "Routes configured in a worker group",
      schema: RoutesOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    pipelines: {
      description: "Pipelines configured in a worker group",
      schema: PipelinesOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    pipeline_detail: {
      description: "Detailed config for a specific pipeline with functions",
      schema: PipelineDetailSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    destinations: {
      description: "Output destinations configured in a worker group",
      schema: DestinationsOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    destination_detail: {
      description: "Detailed config for a specific destination",
      schema: DestinationDetailSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    capture: {
      description: "Captured events from a pipeline point",
      schema: CaptureOutputSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    lookups: {
      description: "Lookup files in a worker group",
      schema: LookupsOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    knowledge: {
      description: "Knowledge objects (parsers, schemas, global variables)",
      schema: KnowledgeOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    health: {
      description: "Aggregated health overview of a worker group",
      schema: HealthOutputSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    notifications: {
      description:
        "Cribl's own raised/resolved alerts for a worker group (unhealthy destination, " +
        "no data received, PQ capacity, license expiry)",
      schema: NotificationsOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    log_files: {
      description:
        "Available log files for a worker group instance (access.log, cribl.log, ...)",
      schema: LogFilesOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    log_lines: {
      description: "Parsed JSON log events read from one worker-group log file",
      schema: LogLinesOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    status_page: {
      description: "Cribl's public status page (status.cribl.cloud) summary",
      schema: StatusPageOutputSchema,
      lifetime: "5m" as const,
      garbageCollection: 10,
    },
    status_page_incidents: {
      description:
        "One page of Cribl's historical status-page incidents (resolved + unresolved)",
      schema: StatusPageIncidentsOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    workers: {
      description:
        "Worker nodes across the organization, with their id, health status, and worker " +
        "group -- use the returned `id` values with get_node_input_status/" +
        "get_node_output_status for per-node (not aggregated) traffic metrics",
      schema: WorkersOutputSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    node_input_status: {
      description:
        "A single worker node's live status/metrics for one input, straight from that " +
        "node -- unlike list_sources/get_source and the group-level `health` method, which " +
        "read a leader-aggregated view that has been observed to report numRequests: 0 " +
        "even while the individual nodes behind it are actively processing traffic",
      schema: NodeInputStatusOutputSchema,
      lifetime: "2m" as const,
      garbageCollection: 10,
    },
    node_output_status: {
      description:
        "A single worker node's live status/metrics for one output, straight from that " +
        "node -- same per-node caveat as node_input_status",
      schema: NodeOutputStatusOutputSchema,
      lifetime: "2m" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list_sources: {
      description:
        "List all input sources in a worker group with their type and enabled/disabled status.",
      arguments: z.object({
        workerGroup: z.string().describe(
          "Worker group name (e.g. default, acceptance)",
        ),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/system/inputs");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];

        // deno-lint-ignore no-explicit-any
        const sources = items.map((item: any) => ({
          id: item.id ?? "unknown",
          type: item.type ?? "unknown",
          disabled: item.disabled ?? false,
          description: item.description ?? undefined,
          config: item,
        }));

        const data = {
          workerGroup: args.workerGroup,
          sources,
          totalCount: sources.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "sources",
          instanceKey("sources", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl sources", {
          workerGroup: args.workerGroup,
          count: sources.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_source: {
      description: "Get detailed configuration for a specific source by ID.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        sourceId: z.string().describe("Source ID"),
      }),
      execute: async (
        args: { workerGroup: string; sourceId: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(
          args.workerGroup,
          `/system/inputs/${encodeURIComponent(args.sourceId)}`,
        );
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];
        // deno-lint-ignore no-explicit-any
        const item = items[0] as any;

        if (!item) {
          throw new Error(
            `Source '${args.sourceId}' not found in worker group '${args.workerGroup}'`,
          );
        }

        const source = {
          id: item.id ?? args.sourceId,
          type: item.type ?? "unknown",
          disabled: item.disabled ?? false,
          description: item.description ?? undefined,
          config: item,
        };

        const data = {
          workerGroup: args.workerGroup,
          source,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "source_detail",
          instanceKey("source", args.workerGroup, args.sourceId),
          data,
        );

        context.logger.info("Fetched Cribl source detail", {
          workerGroup: args.workerGroup,
          sourceId: args.sourceId,
        });
        return { dataHandles: [handle] };
      },
    },

    list_routes: {
      description:
        "List all routes in a worker group with their filter, pipeline, output, and enabled/disabled state.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/routes");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };

        // Cribl routes API returns { items: [{ id, routes: [...] }] }
        // The actual route entries are nested inside items[0].routes
        // deno-lint-ignore no-explicit-any
        const topLevel = resp.items ?? [] as any[];
        // deno-lint-ignore no-explicit-any
        let routeEntries: any[] = [];
        // deno-lint-ignore no-explicit-any
        for (const group of topLevel as any[]) {
          if (group.routes && Array.isArray(group.routes)) {
            routeEntries = routeEntries.concat(group.routes);
          } else if (
            group.filter !== undefined || group.pipeline !== undefined
          ) {
            // Flat structure fallback — item itself is a route
            routeEntries.push(group);
          }
        }

        // deno-lint-ignore no-explicit-any
        const routes = routeEntries.map((item: any) => ({
          id: item.id ?? "unknown",
          name: item.name ?? item.id ?? "unknown",
          filter: item.filter ?? "true",
          pipeline: item.pipeline ?? undefined,
          output: item.output ?? undefined,
          disabled: item.disabled ?? false,
          description: item.description ?? undefined,
          groups: item.groups ?? undefined,
        }));

        const enabledCount =
          routes.filter((r: { disabled: boolean }) => !r.disabled).length;
        const disabledCount =
          routes.filter((r: { disabled: boolean }) => r.disabled).length;

        const data = {
          workerGroup: args.workerGroup,
          routes,
          totalCount: routes.length,
          enabledCount,
          disabledCount,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "routes",
          instanceKey("routes", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl routes", {
          workerGroup: args.workerGroup,
          total: routes.length,
          enabled: enabledCount,
          disabled: disabledCount,
        });
        return { dataHandles: [handle] };
      },
    },

    list_pipelines: {
      description: "List all pipelines in a worker group.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/pipelines");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];

        // deno-lint-ignore no-explicit-any
        const pipelines = items.map((item: any) => ({
          id: item.id ?? "unknown",
          description: item.description ?? undefined,
          disabled: item.disabled ?? false,
          // deno-lint-ignore no-explicit-any
          functions: item.conf?.functions?.map((fn: any) => ({
            id: fn.id ?? "unknown",
            filter: fn.filter ?? undefined,
            disabled: fn.disabled ?? false,
            description: fn.description ?? undefined,
            conf: fn.conf ?? undefined,
          })) ?? undefined,
        }));

        const data = {
          workerGroup: args.workerGroup,
          pipelines,
          totalCount: pipelines.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "pipelines",
          instanceKey("pipelines", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl pipelines", {
          workerGroup: args.workerGroup,
          count: pipelines.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_pipeline: {
      description:
        "Get detailed configuration for a specific pipeline, including all functions.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        pipelineId: z.string().describe("Pipeline ID"),
      }),
      execute: async (
        args: { workerGroup: string; pipelineId: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(
          args.workerGroup,
          `/pipelines/${encodeURIComponent(args.pipelineId)}`,
        );
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];
        // deno-lint-ignore no-explicit-any
        const item = items[0] as any;

        if (!item) {
          throw new Error(
            `Pipeline '${args.pipelineId}' not found in worker group '${args.workerGroup}'`,
          );
        }

        const pipeline = {
          id: item.id ?? args.pipelineId,
          description: item.description ?? undefined,
          disabled: item.disabled ?? false,
          // deno-lint-ignore no-explicit-any
          functions: item.conf?.functions?.map((fn: any) => ({
            id: fn.id ?? "unknown",
            filter: fn.filter ?? undefined,
            disabled: fn.disabled ?? false,
            description: fn.description ?? undefined,
            conf: fn.conf ?? undefined,
          })) ?? [],
        };

        const data = {
          workerGroup: args.workerGroup,
          pipeline,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "pipeline_detail",
          instanceKey("pipeline", args.workerGroup, args.pipelineId),
          data,
        );

        context.logger.info("Fetched Cribl pipeline detail", {
          workerGroup: args.workerGroup,
          pipelineId: args.pipelineId,
          functionCount: pipeline.functions?.length ?? 0,
        });
        return { dataHandles: [handle] };
      },
    },

    list_destinations: {
      description:
        "List all output destinations in a worker group with their type and status.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/system/outputs");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];

        // deno-lint-ignore no-explicit-any
        const destinations = items.map((item: any) => ({
          id: item.id ?? "unknown",
          type: item.type ?? "unknown",
          disabled: item.disabled ?? false,
          description: item.description ?? undefined,
          config: item,
        }));

        const data = {
          workerGroup: args.workerGroup,
          destinations,
          totalCount: destinations.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "destinations",
          instanceKey("destinations", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl destinations", {
          workerGroup: args.workerGroup,
          count: destinations.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_destination: {
      description:
        "Get detailed configuration for a specific destination by ID.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        destinationId: z.string().describe("Destination ID"),
      }),
      execute: async (
        args: { workerGroup: string; destinationId: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(
          args.workerGroup,
          `/system/outputs/${encodeURIComponent(args.destinationId)}`,
        );
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];
        // deno-lint-ignore no-explicit-any
        const item = items[0] as any;

        if (!item) {
          throw new Error(
            `Destination '${args.destinationId}' not found in worker group '${args.workerGroup}'`,
          );
        }

        const destination = {
          id: item.id ?? args.destinationId,
          type: item.type ?? "unknown",
          disabled: item.disabled ?? false,
          description: item.description ?? undefined,
          config: item,
        };

        const data = {
          workerGroup: args.workerGroup,
          destination,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "destination_detail",
          instanceKey("destination", args.workerGroup, args.destinationId),
          data,
        );

        context.logger.info("Fetched Cribl destination detail", {
          workerGroup: args.workerGroup,
          destinationId: args.destinationId,
        });
        return { dataHandles: [handle] };
      },
    },

    capture_events: {
      description:
        "Capture/preview live events at a specific point in the pipeline. " +
        "Returns a sample of events flowing through a given source or pipeline.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        sourceId: z.string().optional().describe(
          "Source ID to capture from (optional if pipelineId given)",
        ),
        pipelineId: z.string().optional().describe(
          "Pipeline ID to capture from (optional if sourceId given)",
        ),
        filter: z.string().optional().describe(
          "Optional filter expression to narrow captured events",
        ),
        maxEvents: z.number().default(10).describe(
          "Maximum number of events to capture (default: 10)",
        ),
      }),
      execute: async (
        args: {
          workerGroup: string;
          sourceId?: string;
          pipelineId?: string;
          filter?: string;
          maxEvents: number;
        },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;

        if (!args.sourceId && !args.pipelineId) {
          throw new Error(
            "Must provide either sourceId or pipelineId for event capture",
          );
        }

        // Cribl Cloud live capture endpoint
        const captureParams: Record<string, unknown> = {
          level: args.pipelineId ? "after" : "before",
          workerCount: 1,
          maxEvents: args.maxEvents,
        };
        if (args.filter) captureParams.filter = args.filter;

        let captureTarget: string;
        if (args.pipelineId) {
          captureTarget = args.pipelineId;
          captureParams.pipelineId = args.pipelineId;
        } else {
          captureTarget = args.sourceId!;
          captureParams.inputId = args.sourceId;
        }

        const path = workerPath(args.workerGroup, "/lib/jobs");
        const jobBody = {
          type: "capture",
          ...captureParams,
        };

        const jobResp = await criblPost(
          baseUrl,
          clientId,
          clientSecret,
          path,
          jobBody,
        ) as {
          items?: Array<{ id?: string }>;
        };

        const jobId = jobResp.items?.[0]?.id;
        if (!jobId) {
          throw new Error("Failed to create capture job — no job ID returned");
        }

        // Poll for capture results (max 30s)
        let events: Array<Record<string, unknown>> = [];
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const resultPath = workerPath(
            args.workerGroup,
            `/lib/jobs/${jobId}/results`,
          );
          try {
            const resultResp = await criblGet(
              baseUrl,
              clientId,
              clientSecret,
              resultPath,
            ) as {
              items?: unknown[];
            };
            if (resultResp.items && resultResp.items.length > 0) {
              events = resultResp.items as Array<Record<string, unknown>>;
              break;
            }
          } catch {
            // Job may still be running, retry
          }
        }

        const capturedEvents = events.slice(0, args.maxEvents).map((e) => ({
          _raw: typeof e._raw === "string" ? e._raw : JSON.stringify(e),
          _time: e._time ?? undefined,
          fields: e,
        }));

        const data = {
          workerGroup: args.workerGroup,
          captureId: jobId,
          filter: args.filter ?? undefined,
          events: capturedEvents,
          eventCount: capturedEvents.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "capture",
          instanceKey("capture", args.workerGroup, captureTarget),
          data,
        );

        context.logger.info("Captured Cribl events", {
          workerGroup: args.workerGroup,
          target: captureTarget,
          eventCount: capturedEvents.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_lookups: {
      description: "List all lookup files available in a worker group.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/system/lookups");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];

        // deno-lint-ignore no-explicit-any
        const lookups = items.map((item: any) => ({
          id: item.id ?? "unknown",
          fileInfo: item.fileInfo ?? undefined,
          size: item.size ?? undefined,
          description: item.description ?? undefined,
        }));

        const data = {
          workerGroup: args.workerGroup,
          lookups,
          totalCount: lookups.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "lookups",
          instanceKey("lookups", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl lookups", {
          workerGroup: args.workerGroup,
          count: lookups.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_knowledge: {
      description:
        "List knowledge objects (parsers, global variables, schemas) in a worker group.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        objectType: z
          .enum(["parsers", "global-variables", "schemas"])
          .default("parsers")
          .describe("Type of knowledge object to list"),
      }),
      execute: async (
        args: { workerGroup: string; objectType: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;

        // Map friendly names to API paths
        const apiPaths: Record<string, string> = {
          parsers: "/parsers",
          "global-variables": "/lib/vars",
          schemas: "/schemas",
        };

        const subpath = apiPaths[args.objectType] ?? `/lib/${args.objectType}`;
        const path = workerPath(args.workerGroup, subpath);
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: unknown[];
        };
        const items = resp.items ?? [];

        // deno-lint-ignore no-explicit-any
        const objects = items.map((item: any) => ({
          id: item.id ?? "unknown",
          type: args.objectType,
          description: item.description ?? undefined,
          config: item,
        }));

        const data = {
          workerGroup: args.workerGroup,
          objectType: args.objectType,
          objects,
          totalCount: objects.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "knowledge",
          instanceKey("knowledge", args.workerGroup, args.objectType),
          data,
        );

        context.logger.info("Fetched Cribl knowledge objects", {
          workerGroup: args.workerGroup,
          objectType: args.objectType,
          count: objects.length,
        });
        return { dataHandles: [handle] };
      },
    },

    health: {
      description:
        "Fan-out health check: scans all sources, routes, pipelines, and destinations " +
        "in a worker group and flags any that are disabled or misconfigured.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;

        // Fetch all four object types in parallel
        const [sourcesResp, routesResp, pipelinesResp, destsResp] =
          await Promise.all([
            criblGet(
              baseUrl,
              clientId,
              clientSecret,
              workerPath(args.workerGroup, "/system/inputs"),
            ) as Promise<{ items?: unknown[] }>,
            criblGet(
              baseUrl,
              clientId,
              clientSecret,
              workerPath(args.workerGroup, "/routes"),
            ) as Promise<{ items?: unknown[] }>,
            criblGet(
              baseUrl,
              clientId,
              clientSecret,
              workerPath(args.workerGroup, "/pipelines"),
            ) as Promise<{ items?: unknown[] }>,
            criblGet(
              baseUrl,
              clientId,
              clientSecret,
              workerPath(args.workerGroup, "/system/outputs"),
            ) as Promise<{ items?: unknown[] }>,
          ]);

        const components: Array<{
          type: string;
          id: string;
          status: "healthy" | "warning" | "error" | "disabled";
          message?: string;
        }> = [];

        // Check sources
        // deno-lint-ignore no-explicit-any
        for (const item of (sourcesResp.items ?? []) as any[]) {
          if (item.disabled) {
            components.push({
              type: "source",
              id: item.id,
              status: "disabled",
              message: "Source is disabled",
            });
          } else {
            components.push({ type: "source", id: item.id, status: "healthy" });
          }
        }

        // Check routes
        // deno-lint-ignore no-explicit-any
        for (const item of (routesResp.items ?? []) as any[]) {
          if (item.disabled) {
            components.push({
              type: "route",
              id: item.id ?? item.name,
              status: "disabled",
              message: "Route is disabled",
            });
          } else if (!item.pipeline && !item.output) {
            components.push({
              type: "route",
              id: item.id ?? item.name,
              status: "warning",
              message: "Route has no pipeline or output",
            });
          } else {
            components.push({
              type: "route",
              id: item.id ?? item.name,
              status: "healthy",
            });
          }
        }

        // Check pipelines
        // deno-lint-ignore no-explicit-any
        for (const item of (pipelinesResp.items ?? []) as any[]) {
          if (item.disabled) {
            components.push({
              type: "pipeline",
              id: item.id,
              status: "disabled",
              message: "Pipeline is disabled",
            });
          } else {
            components.push({
              type: "pipeline",
              id: item.id,
              status: "healthy",
            });
          }
        }

        // Check destinations
        // deno-lint-ignore no-explicit-any
        for (const item of (destsResp.items ?? []) as any[]) {
          if (item.disabled) {
            components.push({
              type: "destination",
              id: item.id,
              status: "disabled",
              message: "Destination is disabled",
            });
          } else {
            components.push({
              type: "destination",
              id: item.id,
              status: "healthy",
            });
          }
        }

        // Determine overall health
        const hasError = components.some((c) => c.status === "error");
        const hasWarning = components.some((c) => c.status === "warning");
        const overall = hasError ? "error" : hasWarning ? "warning" : "healthy";

        const data = {
          workerGroup: args.workerGroup,
          overall,
          components,
          sourcesTotal: (sourcesResp.items ?? []).length,
          destinationsTotal: (destsResp.items ?? []).length,
          pipelinesTotal: (pipelinesResp.items ?? []).length,
          routesTotal: (routesResp.items ?? []).length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "health",
          instanceKey("health", args.workerGroup),
          data,
        );

        context.logger.info("Cribl health check complete", {
          workerGroup: args.workerGroup,
          overall,
          components: components.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_notifications: {
      description:
        "List Cribl's own raised/resolved notifications for a worker group -- its native " +
        "alerting for unhealthy destinations, no-data-received sources, and PQ capacity. " +
        "This is a separate, group-scoped alert feed from the per-source/destination " +
        "`config.status.notifications` field returned by get_source/get_destination, which " +
        "has been observed to always be empty in practice. An empty result here despite a " +
        "Red destination status means Cribl's own alerting hasn't fired for the condition, " +
        "not that everything is fine.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/notifications");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: Record<string, unknown>[];
          count?: number;
        };

        const data = {
          workerGroup: args.workerGroup,
          items: resp.items ?? [],
          count: resp.count ?? (resp.items?.length ?? 0),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "notifications",
          instanceKey("notifications", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl notifications", {
          workerGroup: args.workerGroup,
          count: data.count,
        });
        return { dataHandles: [handle] };
      },
    },

    list_log_files: {
      description:
        "List available log files for a worker group's instance (access.log, audit.log, " +
        "cribl.log, cribl_stderr.log, ...), each with id/path/size. Use the returned `id` " +
        "values (e.g. '__instance__:cribl.log') with get_log_lines.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
      }),
      execute: async (
        args: { workerGroup: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = workerPath(args.workerGroup, "/system/logs");
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: Record<string, unknown>[];
        };

        const data = {
          workerGroup: args.workerGroup,
          files: resp.items ?? [],
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "log_files",
          instanceKey("log-files", args.workerGroup),
          data,
        );

        context.logger.info("Fetched Cribl log file list", {
          workerGroup: args.workerGroup,
          fileCount: data.files.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_log_lines: {
      description:
        "Read parsed JSON log events from one worker-group log file (see list_log_files for " +
        "valid fileIds, e.g. '__instance__:cribl.log'). Without `filter`, returns only the " +
        "current live tail -- pass a JS boolean expression in `filter` (evaluated per event " +
        "against fields like `_raw`, `message`, `channel`, `level`, e.g. " +
        "\"_raw.includes('datadog') || _raw.includes('decrypt')\") to search further back. " +
        "This is the only way to see actual runtime errors (auth failures, secret decrypt " +
        "failures, destination connection errors) that never surface in source/destination " +
        "config or health-check output.",
      arguments: z.object({
        workerGroup: z.string().describe("Worker group name"),
        fileId: z.string().describe(
          "Log file id from list_log_files, e.g. '__instance__:cribl.log'",
        ),
        filter: z.string().optional().describe(
          "JS boolean expression evaluated per event, e.g. \"_raw.includes('datadog')\"",
        ),
      }),
      execute: async (
        args: { workerGroup: string; fileId: string; filter?: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const query = args.filter
          ? `?filter=${encodeURIComponent(args.filter)}`
          : "";
        const path = workerPath(
          args.workerGroup,
          `/system/logs/${encodeURIComponent(args.fileId)}${query}`,
        );
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: {
            events?: Record<string, unknown>[];
            endOfResults?: boolean;
          }[];
        };
        const item = resp.items?.[0];

        const data = {
          workerGroup: args.workerGroup,
          fileId: args.fileId,
          filter: args.filter,
          events: item?.events ?? [],
          endOfResults: item?.endOfResults,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "log_lines",
          instanceKey(
            "log-lines",
            args.workerGroup,
            args.fileId.replace(/[^a-zA-Z0-9]/g, "_"),
          ),
          data,
        );

        context.logger.info("Fetched Cribl log lines", {
          workerGroup: args.workerGroup,
          fileId: args.fileId,
          eventCount: data.events.length,
        });
        return { dataHandles: [handle] };
      },
    },

    check_status_page: {
      description:
        "Check Cribl's public status page (status.cribl.cloud) for the overall system " +
        "indicator, any unresolved incidents, and active scheduled maintenances. " +
        "Unauthenticated -- doesn't use globalArgs, unlike every other method on this model.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const [statusResp, incidentsResp, maintResp] = await Promise.all([
          fetch(`${CRIBL_STATUSPAGE_BASE}/status.json`),
          fetch(`${CRIBL_STATUSPAGE_BASE}/incidents/unresolved.json`),
          fetch(`${CRIBL_STATUSPAGE_BASE}/scheduled-maintenances/active.json`),
        ]);

        for (
          const [name, resp] of [
            ["status", statusResp],
            ["incidents", incidentsResp],
            ["maintenances", maintResp],
          ] as const
        ) {
          if (!resp.ok) {
            throw new Error(
              `Cribl status page ${name} fetch failed: ${resp.status}`,
            );
          }
        }

        const status = await statusResp.json() as {
          status: { indicator: string; description: string };
        };
        const incidents = await incidentsResp.json() as {
          incidents: Record<string, unknown>[];
        };
        const maintenances = await maintResp.json() as {
          scheduled_maintenances: Record<string, unknown>[];
        };

        const data = {
          indicator: status.status.indicator,
          description: status.status.description,
          unresolvedIncidents: incidents.incidents ?? [],
          activeMaintenances: maintenances.scheduled_maintenances ?? [],
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "status_page",
          "status-page",
          data,
        );

        context.logger.info("Checked Cribl status page", {
          indicator: data.indicator,
          unresolvedIncidents: data.unresolvedIncidents.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_status_page_incidents: {
      description:
        "List Cribl's historical status-page incidents (resolved and unresolved), most " +
        "recent first -- unlike check_status_page, which only covers what's unresolved right " +
        "now. Use to check whether a past outage window was ever publicly acknowledged, even " +
        "if since resolved (e.g. a rolling-upgrade fix for a known secrets/auth bug that may " +
        "still explain a since-observed regression). Unauthenticated -- doesn't use globalArgs.",
      arguments: z.object({
        page: z.number().int().min(1).default(1).describe(
          "Page number for the statuspage.io incidents.json endpoint",
        ),
      }),
      execute: async (
        args: { page: number },
        context: ModelContext,
      ) => {
        const resp = await fetch(
          `${CRIBL_STATUSPAGE_BASE}/incidents.json?page=${args.page}`,
        );
        if (!resp.ok) {
          throw new Error(
            `Cribl status page incidents fetch failed: ${resp.status}`,
          );
        }
        const body = await resp.json() as {
          incidents: Record<string, unknown>[];
        };

        const data = {
          page: args.page,
          incidents: body.incidents ?? [],
          count: body.incidents?.length ?? 0,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "status_page_incidents",
          instanceKey("status-page-incidents", `p${args.page}`),
          data,
        );

        context.logger.info("Fetched Cribl status page incidents", {
          page: args.page,
          count: data.count,
        });
        return { dataHandles: [handle] };
      },
    },

    list_workers: {
      description:
        "List worker nodes across the organization (id, health status, worker group, " +
        "hostname/platform). Use the returned `id` values with get_node_input_status/" +
        "get_node_output_status to check a specific node's actual traffic, rather than " +
        "the leader-aggregated view that list_sources/get_source/health rely on.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const resp = await criblGet(
          baseUrl,
          clientId,
          clientSecret,
          "/api/v1/products/stream/workers",
        ) as {
          items?: {
            id: string;
            status: string;
            group: string;
            info?: Record<string, unknown>;
          }[];
        };

        const workers = (resp.items ?? []).map((w) => ({
          id: w.id,
          status: w.status,
          group: w.group,
          hostname: w.info?.hostname,
          platform: w.info?.platform,
          architecture: w.info?.architecture,
          cpus: w.info?.cpus,
        }));

        const data = {
          workers,
          count: workers.length,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "workers",
          "workers-all",
          data,
        );

        context.logger.info("Fetched Cribl worker nodes", {
          count: data.count,
        });
        return { dataHandles: [handle] };
      },
    },

    get_node_input_status: {
      description:
        "Get one worker node's own live status/metrics for one input, bypassing the " +
        "leader-aggregated view. Use list_workers to find node ids for a worker group.",
      arguments: z.object({
        nodeId: z.string().describe("Worker node id (from list_workers)"),
        sourceId: z.string().describe("Source/input id"),
      }),
      execute: async (
        args: { nodeId: string; sourceId: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = `/api/v1/w/${encodeURIComponent(args.nodeId)}` +
          `/system/status/inputs/${
            encodeURIComponent(args.sourceId)
          }?metrics=1`;
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: Record<string, unknown>[];
        };

        const data = {
          nodeId: args.nodeId,
          sourceId: args.sourceId,
          status: (resp.items?.[0]?.status as Record<string, unknown>) ?? null,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "node_input_status",
          instanceKey("node-input-status", args.nodeId, args.sourceId),
          data,
        );

        context.logger.info("Fetched per-node input status", {
          nodeId: args.nodeId,
          sourceId: args.sourceId,
        });
        return { dataHandles: [handle] };
      },
    },

    get_node_output_status: {
      description:
        "Get one worker node's own live status/metrics for one output, bypassing the " +
        "leader-aggregated view. Use list_workers to find node ids for a worker group.",
      arguments: z.object({
        nodeId: z.string().describe("Worker node id (from list_workers)"),
        destinationId: z.string().describe("Destination/output id"),
      }),
      execute: async (
        args: { nodeId: string; destinationId: string },
        context: ModelContext,
      ) => {
        const { baseUrl, clientId, clientSecret } = context.globalArgs;
        const path = `/api/v1/w/${encodeURIComponent(args.nodeId)}` +
          `/system/status/outputs/${
            encodeURIComponent(args.destinationId)
          }?metrics=1`;
        const resp = await criblGet(baseUrl, clientId, clientSecret, path) as {
          items?: Record<string, unknown>[];
        };

        const data = {
          nodeId: args.nodeId,
          destinationId: args.destinationId,
          status: (resp.items?.[0]?.status as Record<string, unknown>) ?? null,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "node_output_status",
          instanceKey("node-output-status", args.nodeId, args.destinationId),
          data,
        );

        context.logger.info("Fetched per-node output status", {
          nodeId: args.nodeId,
          destinationId: args.destinationId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
