// ABOUTME: Records webhook payloads received from Coder notifications.
// ABOUTME: Stores events with receipt timestamp for delivery latency analysis.
import { z } from "zod";

const GlobalArgsSchema = z.object({});

const WebhookEventSchema = z.object({
  msgId: z.string(),
  title: z.string(),
  body: z.string().optional(),
  notificationName: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  actions: z.array(z.object({
    label: z.string(),
    url: z.string(),
  })).optional(),
  receivedAt: z.string(),
  rawPayloadSize: z.number(),
});

/** Model definition for recording Coder webhook notification events. */
export const model = {
  type: "@twonines/coder-event-log",
  version: "2026.05.31.1",
  description:
    "Records webhook payloads from Coder notifications for delivery and latency analysis.",
  globalArguments: GlobalArgsSchema,
  resources: {
    event: {
      description: "Recorded webhook event with receipt metadata",
      schema: WebhookEventSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    record: {
      description: "Record an incoming webhook payload",
      arguments: z.object({
        payload: z.string().describe("Raw JSON payload from the webhook"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const rawPayload = (args as { payload: string }).payload;
        const receivedAt = new Date().toISOString();

        context.logger.info("Recording webhook event ({size} bytes)", {
          size: rawPayload.length,
        });

        // deno-lint-ignore no-explicit-any
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch (err) {
          context.logger.error("Failed to parse webhook payload: {err}", {
            err: String(err),
          });
          throw new Error(`Invalid JSON payload: ${err}`);
        }

        const payload = parsed.payload || {};
        const event = {
          msgId: parsed.msg_id || "unknown",
          title: parsed.title || "",
          body: parsed.body,
          notificationName: payload.notification_name,
          labels: payload.labels,
          // deno-lint-ignore no-explicit-any
          actions: payload.actions?.map((a: any) => ({
            label: a.label,
            url: a.url,
          })),
          receivedAt,
          rawPayloadSize: rawPayload.length,
        };

        context.logger.info("Recorded event: {name} (msg_id={id})", {
          name: event.notificationName || event.title,
          id: event.msgId,
        });

        const handle = await context.writeResource("event", event.msgId, event);
        return { dataHandles: [handle] };
      },
    },
  },
};
