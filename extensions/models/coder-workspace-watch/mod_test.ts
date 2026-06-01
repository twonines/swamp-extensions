// ABOUTME: Unit tests for coder-workspace-watch extension model.
// ABOUTME: Validates workspace observation against mocked API responses.
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

Deno.test("observe - captures running workspace state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    assertEquals(url.includes("q=name:my-sandbox"), true);
    const headers = init?.headers as Record<string, string> | undefined;
    assertEquals(headers?.["Coder-Session-Token"], "test-token");

    return Promise.resolve(
      new Response(
        JSON.stringify({
          workspaces: [
            {
              id: "ws-uuid-123",
              name: "my-sandbox",
              owner_name: "admin",
              status: "running",
              template_name: "sandbox",
              created_at: "2026-05-30T10:00:00Z",
              last_used_at: "2026-05-31T12:00:00Z",
              latest_build: {
                status: "running",
                resources: [
                  {
                    agents: [
                      { status: "connected", version: "v2.10.0" },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "test-token" },
      methodName: "observe",
    });

    const result = await model.methods.observe.execute(
      { workspace: "my-sandbox" },
      context,
    );
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const snapshot = resources[0].data as any;
    assertEquals(snapshot.workspaceId, "ws-uuid-123");
    assertEquals(snapshot.workspaceName, "my-sandbox");
    assertEquals(snapshot.ownerName, "admin");
    assertEquals(snapshot.status, "running");
    assertEquals(snapshot.latestBuildStatus, "running");
    assertEquals(snapshot.agentStatus, "connected");
    assertEquals(snapshot.agentVersion, "v2.10.0");
    assertEquals(snapshot.templateName, "sandbox");
    assertEquals(snapshot.error, undefined);
    assertEquals(resources[0].name, "my-sandbox");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("observe - workspace not found records error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ workspaces: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "test-token" },
      methodName: "observe",
    });

    await model.methods.observe.execute({ workspace: "nonexistent" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.status, "error");
    assertEquals(data.error.includes("not found"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("observe - API error records gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(new Response("Forbidden", { status: 403 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "bad-token" },
      methodName: "observe",
    });

    await model.methods.observe.execute({ workspace: "my-sandbox" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.status, "error");
    assertEquals(data.error.includes("403"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("observe - network error records gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "test-token" },
      methodName: "observe",
    });

    await model.methods.observe.execute({ workspace: "my-sandbox" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.status, "error");
    assertEquals(data.error.includes("Connection refused"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
