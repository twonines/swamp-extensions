// ABOUTME: Unit tests for coder-audit-collector extension model.
// ABOUTME: Validates audit log collection against mocked API responses.
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

Deno.test("collect - fetches audit events successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    assertEquals(headers?.["Coder-Session-Token"], "test-token");

    return Promise.resolve(
      new Response(
        JSON.stringify({
          audit_logs: [
            {
              id: "evt-1",
              time: "2026-05-31T00:00:00Z",
              action: "create",
              resource_type: "workspace",
              resource_id: "ws-123",
              user: { id: "user-1" },
              status_code: 201,
              description: "Created workspace",
            },
            {
              id: "evt-2",
              time: "2026-05-30T23:00:00Z",
              action: "start",
              resource_type: "workspace_build",
              resource_id: "build-456",
              user: { id: "user-1" },
              status_code: 200,
              description: "Started build",
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
      methodName: "collect",
    });

    const result = await model.methods.collect.execute(
      { limit: 50, query: "" },
      context,
    );
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const data = resources[0].data as any;
    assertEquals(data.count, 2);
    assertEquals(data.events[0].id, "evt-1");
    assertEquals(data.events[0].action, "create");
    assertEquals(data.events[0].resourceType, "workspace");
    assertEquals(data.newestEvent, "2026-05-31T00:00:00Z");
    assertEquals(data.oldestEvent, "2026-05-30T23:00:00Z");
    assertEquals(data.error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("collect - handles API error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(
      new Response("Unauthorized", { status: 401 }),
    );
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "bad-token" },
      methodName: "collect",
    });

    await model.methods.collect.execute({ limit: 50, query: "" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.count, 0);
    assertEquals(data.events.length, 0);
    assertEquals(typeof data.error, "string");
    assertEquals(data.error.includes("401"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("collect - handles network error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000", token: "test-token" },
      methodName: "collect",
    });

    await model.methods.collect.execute({ limit: 50, query: "" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.count, 0);
    assertEquals(data.error.includes("Connection refused"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
