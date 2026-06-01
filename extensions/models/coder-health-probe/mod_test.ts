// ABOUTME: Unit tests for coder-health-probe extension model.
// ABOUTME: Validates health check logic against mocked HTTP responses.
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

Deno.test("check - both endpoints healthy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/healthz")) {
      return Promise.resolve(
        new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    }
    if (url.includes("/api/v2/buildinfo")) {
      return Promise.resolve(
        new Response(JSON.stringify({ version: "v2.10.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000" },
      methodName: "check",
    });

    const result = await model.methods.check.execute({}, context);
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const data = resources[0].data as any;
    assertEquals(data.healthy, true);
    assertEquals(data.status, "reachable");
    assertEquals(data.version, "v2.10.0");
    assertEquals(typeof data.healthzLatencyMs, "number");
    assertEquals(typeof data.buildinfoLatencyMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("check - healthz ok but buildinfo fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/healthz")) {
      return Promise.resolve(
        new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    }
    return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000" },
      methodName: "check",
    });

    await model.methods.check.execute({}, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.healthy, false);
    assertEquals(data.status, "unhealthy");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("check - both endpoints unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "http://localhost:3000" },
      methodName: "check",
    });

    await model.methods.check.execute({}, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.healthy, false);
    assertEquals(data.status, "unreachable");
    assertEquals(typeof data.error, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
