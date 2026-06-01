// ABOUTME: Unit tests for coder-metrics-sampler extension model.
// ABOUTME: Validates Prometheus text parsing and metric extraction.
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

const SAMPLE_PROMETHEUS_OUTPUT = `# HELP coderd_api_requests_processed_total Total API requests
# TYPE coderd_api_requests_processed_total counter
coderd_api_requests_processed_total 4523
# HELP coderd_api_request_latencies_seconds API request latencies
# TYPE coderd_api_request_latencies_seconds histogram
coderd_api_request_latencies_seconds{quantile="0.5"} 0.012
coderd_api_request_latencies_seconds{quantile="0.95"} 0.089
coderd_api_request_latencies_seconds_count 4523
# HELP coderd_api_workspace_latest_build_status Workspace build status
# TYPE coderd_api_workspace_latest_build_status gauge
coderd_api_workspace_latest_build_status{status="running"} 3
coderd_api_workspace_latest_build_status{status="stopped"} 1
# HELP coderd_provisionerd_jobs_current Active provisioner jobs
# TYPE coderd_provisionerd_jobs_current gauge
coderd_provisionerd_jobs_current 0
`;

Deno.test("scrape - parses prometheus metrics successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(
      new Response(SAMPLE_PROMETHEUS_OUTPUT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { metricsUrl: "http://localhost:2112/metrics" },
      methodName: "scrape",
    });

    const result = await model.methods.scrape.execute({}, context);
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const sample = resources[0].data as any;
    assertEquals(sample.scrapeSuccess, true);
    assertEquals(sample.apiRequestsTotal, 4523);
    assertEquals(sample.apiRequestLatencyP50Ms, 12);
    assertEquals(sample.apiRequestLatencyP95Ms, 89);
    assertEquals(sample.workspacesRunning, 3);
    assertEquals(sample.workspacesStopped, 1);
    assertEquals(sample.provisionerJobsActive, 0);
    assertEquals(sample.error, undefined);
    assertEquals(sample.rawMetricCount > 0, true);
    assertEquals(typeof sample.scrapeDurationMs, "number");
    assertEquals(typeof sample.sampledAt, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("scrape - handles HTTP error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { metricsUrl: "http://localhost:2112/metrics" },
      methodName: "scrape",
    });

    await model.methods.scrape.execute({}, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.scrapeSuccess, false);
    assertEquals(data.error, "HTTP 503");
    assertEquals(data.rawMetricCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("scrape - handles network failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.reject(new Error("ECONNREFUSED"));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { metricsUrl: "http://localhost:2112/metrics" },
      methodName: "scrape",
    });

    await model.methods.scrape.execute({}, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.scrapeSuccess, false);
    assertEquals(data.error.includes("ECONNREFUSED"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("scrape - handles empty metrics response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(
      new Response("", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { metricsUrl: "http://localhost:2112/metrics" },
      methodName: "scrape",
    });

    await model.methods.scrape.execute({}, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.scrapeSuccess, true);
    assertEquals(data.rawMetricCount, 0);
    assertEquals(data.apiRequestsTotal, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
