// ABOUTME: Pages through the Coder audit log API collecting events incrementally.
// ABOUTME: Writes batches of audit events as versioned data for analysis.
import { z } from "zod";

const GlobalArgsSchema = z.object({
  url: z.string().url().default("http://localhost:3000"),
  token: z.string().describe("Coder API session token").meta({
    sensitive: true,
  }),
});

const AuditEventSchema = z.object({
  id: z.string(),
  time: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  userId: z.string().optional(),
  statusCode: z.number().optional(),
  description: z.string().optional(),
});

const AuditBatchSchema = z.object({
  events: z.array(AuditEventSchema),
  count: z.number(),
  oldestEvent: z.string().optional(),
  newestEvent: z.string().optional(),
  collectedAt: z.string(),
  error: z.string().optional(),
});

/** Model definition for collecting Coder audit log entries. */
export const model = {
  type: "@twonines/coder-audit-collector",
  version: "2026.05.31.1",
  description:
    "Pages through the Coder audit log API and writes events as versioned data for analysis.",
  globalArguments: GlobalArgsSchema,
  resources: {
    batch: {
      description: "Batch of collected audit events",
      schema: AuditBatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    collect: {
      description: "Fetch recent audit events and record them",
      arguments: z.object({
        limit: z.number().default(50),
        query: z.string().default(""),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const url = context.globalArgs.url;
        const token = context.globalArgs.token;
        const limit = (args as { limit: number }).limit;
        const query = (args as { query: string }).query;

        context.logger.info(
          "Collecting audit events from {url} (limit={limit})",
          {
            url,
            limit,
          },
        );

        const params = new URLSearchParams({
          limit: String(limit),
        });
        if (query) params.set("q", query);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const res = await fetch(`${url}/api/v2/audit?${params}`, {
            headers: {
              "Coder-Session-Token": token,
              Accept: "application/json",
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Audit API returned ${res.status}: ${errText}`);
          }

          const data = await res.json();
          const rawEvents = data.audit_logs || [];

          // deno-lint-ignore no-explicit-any
          const events = rawEvents.map((e: any) => ({
            id: e.id,
            time: e.time,
            action: e.action,
            resourceType: e.resource_type,
            resourceId: e.resource_id,
            userId: e.user?.id,
            statusCode: e.status_code,
            description: e.description,
          }));

          const batch = {
            events,
            count: events.length,
            oldestEvent: events.length > 0
              ? events[events.length - 1].time
              : undefined,
            newestEvent: events.length > 0 ? events[0].time : undefined,
            collectedAt: new Date().toISOString(),
          };

          context.logger.info("Collected {count} audit events", {
            count: events.length,
          });

          const handle = await context.writeResource("batch", "current", batch);
          return { dataHandles: [handle] };
        } catch (err) {
          clearTimeout(timeout);
          const batch = {
            events: [],
            count: 0,
            collectedAt: new Date().toISOString(),
            error: String(err),
          };

          context.logger.error("Audit collection failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource("batch", "current", batch);
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
