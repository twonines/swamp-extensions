// ABOUTME: Queries the Coder workspace API and captures state snapshots.
// ABOUTME: Records workspace status for stability and drift analysis.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().url().default("http://localhost:3000"),
  token: z.string().describe("Coder API session token").meta({
    sensitive: true,
  }),
});

const WorkspaceSnapshotSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  ownerName: z.string(),
  status: z.string(),
  latestBuildStatus: z.string().optional(),
  agentStatus: z.string().optional(),
  agentVersion: z.string().optional(),
  templateName: z.string().optional(),
  createdAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  observedAt: z.string(),
  error: z.string().optional(),
});

/** Model definition for observing Coder workspace state. */
export const model = {
  type: "@twonines/coder-workspace-watch",
  version: "2026.07.20.1",
  description:
    "Observes Coder workspace state via the API and records typed snapshots for stability analysis.",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshot: {
      description: "Workspace state snapshot at a point in time",
      schema: WorkspaceSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    observe: {
      description: "Fetch current workspace state and record a snapshot",
      arguments: z.object({
        workspace: z.string().describe("Workspace name to observe"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const url = context.globalArgs.url;
        const token = context.globalArgs.token;
        const workspaceName = (args as { workspace: string }).workspace;

        context.logger.info("Observing workspace {name}", {
          name: workspaceName,
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const res = await fetch(
            `${url}/api/v2/workspaces?q=name:${workspaceName}`,
            {
              headers: {
                "Coder-Session-Token": token,
                Accept: "application/json",
              },
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);

          if (!res.ok) {
            throw new Error(`Workspace API returned ${res.status}`);
          }

          const data = await res.json();
          const workspaces = data.workspaces || [];

          if (workspaces.length === 0) {
            throw new Error(`Workspace "${workspaceName}" not found`);
          }

          const ws = workspaces[0];
          const latestBuild = ws.latest_build;
          const agent = latestBuild?.resources
            // deno-lint-ignore no-explicit-any
            ?.flatMap((r: any) => r.agents || [])
            ?.[0];

          const snapshot = {
            workspaceId: ws.id,
            workspaceName: ws.name,
            ownerName: ws.owner_name,
            status: ws.status || latestBuild?.status || "unknown",
            latestBuildStatus: latestBuild?.status,
            agentStatus: agent?.status,
            agentVersion: agent?.version,
            templateName: ws.template_name,
            createdAt: ws.created_at,
            lastUsedAt: ws.last_used_at,
            observedAt: new Date().toISOString(),
          };

          context.logger.info(
            "Workspace {name}: status={status}, agent={agent}",
            {
              name: workspaceName,
              status: snapshot.status,
              agent: snapshot.agentStatus || "none",
            },
          );

          const handle = await context.writeResource(
            "snapshot",
            workspaceName,
            snapshot,
          );
          return { dataHandles: [handle] };
        } catch (err) {
          clearTimeout(timeout);
          const snapshot = {
            workspaceId: "unknown",
            workspaceName,
            ownerName: "unknown",
            status: "error",
            observedAt: new Date().toISOString(),
            error: String(err),
          };

          context.logger.error("Workspace observation failed: {err}", {
            err: String(err),
          });

          const handle = await context.writeResource(
            "snapshot",
            workspaceName,
            snapshot,
          );
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
