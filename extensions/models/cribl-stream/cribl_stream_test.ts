// ABOUTME: Unit tests for the cribl-stream extension model.
// ABOUTME: Validates check_status_page, list_notifications, get_log_lines, list_workers,
// ABOUTME: get_node_input_status, and get_node_output_status against mocked HTTP responses.
import { assertEquals } from "@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./cribl_stream.ts";

function mockOAuthAnd(handler: (url: string) => Response | Promise<Response>) {
  return (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://login.cribl.cloud/oauth/token") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return Promise.resolve(handler(url));
  };
}

Deno.test("check_status_page - reports the public status indicator", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/status.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: {
              indicator: "none",
              description: "All Systems Operational",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/incidents/unresolved.json")) {
      return Promise.resolve(
        new Response(JSON.stringify({ incidents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/scheduled-maintenances/active.json")) {
      return Promise.resolve(
        new Response(JSON.stringify({ scheduled_maintenances: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "check_status_page",
    });

    await model.methods.check_status_page.execute(
      {},
      context as unknown as Parameters<
        typeof model.methods.check_status_page.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.indicator, "none");
    assertEquals(data.unresolvedIncidents.length, 0);
    assertEquals(data.activeMaintenances.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("list_notifications - passes through the worker group's alert feed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOAuthAnd((url) => {
    if (url.endsWith("/api/v1/m/default/notifications")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "n1", title: "Destination unhealthy" }],
          count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "list_notifications",
    });

    await model.methods.list_notifications.execute(
      { workerGroup: "default" },
      context as unknown as Parameters<
        typeof model.methods.list_notifications.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.workerGroup, "default");
    assertEquals(data.count, 1);
    assertEquals(data.items.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("get_log_lines - reads events from the requested log file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOAuthAnd((url) => {
    if (url.includes("/system/logs/")) {
      return new Response(
        JSON.stringify({
          items: [{
            file: "__instance__:cribl.log",
            events: [{
              time: "2026-08-25T14:14:38.625Z",
              channel: "criblsecret",
              level: "error",
            }],
            endOfResults: true,
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "get_log_lines",
    });

    await model.methods.get_log_lines.execute(
      {
        workerGroup: "default",
        fileId: "__instance__:cribl.log",
        filter: "level == 'error'",
      },
      context as unknown as Parameters<
        typeof model.methods.get_log_lines.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.events.length, 1);
    assertEquals(data.events[0].channel, "criblsecret");
    assertEquals(data.endOfResults, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("list_workers - lists worker nodes and excludes their env block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOAuthAnd((url) => {
    if (url.endsWith("/api/v1/products/stream/workers")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "node-1",
              status: "healthy",
              group: "default",
              info: {
                hostname: "ip-10-0-0-1",
                platform: "linux",
                architecture: "arm64",
                cpus: 4,
                env: { CRIBL_CLOUD_KEY: "should-not-appear" },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "list_workers",
    });

    await model.methods.list_workers.execute(
      {},
      context as unknown as Parameters<
        typeof model.methods.list_workers.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.count, 1);
    assertEquals(data.workers[0].id, "node-1");
    assertEquals(data.workers[0].group, "default");
    assertEquals(data.workers[0].hostname, "ip-10-0-0-1");
    assertEquals("env" in data.workers[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("get_node_input_status - reads one node's own input status directly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOAuthAnd((url) => {
    if (url.includes("/system/status/inputs/open_telemetry")) {
      return new Response(
        JSON.stringify({
          items: [{
            id: "open_telemetry",
            status: {
              health: "Green",
              metrics: {
                numRequests: 42,
                numPushed: 200,
                numErrors: 0,
                numDropped: 0,
              },
            },
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "get_node_input_status",
    });

    await model.methods.get_node_input_status.execute(
      { nodeId: "node-1", sourceId: "open_telemetry" },
      context as unknown as Parameters<
        typeof model.methods.get_node_input_status.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.nodeId, "node-1");
    assertEquals(data.sourceId, "open_telemetry");
    assertEquals(data.status.metrics.numRequests, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("get_node_output_status - reads one node's own output status directly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOAuthAnd((url) => {
    if (url.includes("/system/status/outputs/datadog-claude-code")) {
      return new Response(
        JSON.stringify({
          items: [{
            id: "datadog-claude-code",
            status: {
              health: "Green",
              metrics: { sentCount: 500, bytesOut: 12345, numDropped: 0 },
            },
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        baseUrl: "https://example.cribl.cloud",
        clientId: "id",
        clientSecret: "secret",
      },
      methodName: "get_node_output_status",
    });

    await model.methods.get_node_output_status.execute(
      { nodeId: "node-1", destinationId: "datadog-claude-code" },
      context as unknown as Parameters<
        typeof model.methods.get_node_output_status.execute
      >[1],
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.nodeId, "node-1");
    assertEquals(data.destinationId, "datadog-claude-code");
    assertEquals(data.status.metrics.sentCount, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
