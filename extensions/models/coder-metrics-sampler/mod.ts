// ABOUTME: Scrapes Prometheus metrics from Coder's metrics endpoint.
// ABOUTME: Extracts key operational metrics and writes typed snapshots for trend analysis.
import { z } from "zod";

const GlobalArgsSchema = z.object({
  metricsUrl: z.string().url().default("http://localhost:2112/metrics"),
});

const MetricsSampleSchema = z.object({
  apiRequestsTotal: z.number().optional(),
  apiRequestLatencyP50Ms: z.number().optional(),
  apiRequestLatencyP95Ms: z.number().optional(),
  workspacesRunning: z.number().optional(),
  workspacesStopped: z.number().optional(),
  agentConnectionsTotal: z.number().optional(),
  provisionerJobsActive: z.number().optional(),
  scrapeDurationMs: z.number(),
  scrapeSuccess: z.boolean(),
  sampledAt: z.string(),
  error: z.string().optional(),
  rawMetricCount: z.number(),
});

function parsePrometheusText(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+\.?\d*(?:e[+-]?\d+)?)/,
    );
    if (match) {
      metrics.set(match[1], parseFloat(match[2]));
    }
    const labelMatch = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+(-?\d+\.?\d*(?:e[+-]?\d+)?)/,
    );
    if (labelMatch) {
      const key = `${labelMatch[1]}{${labelMatch[2]}}`;
      metrics.set(key, parseFloat(labelMatch[3]));
    }
  }
  return metrics;
}

function findMetric(
  metrics: Map<string, number>,
  prefix: string,
): number | undefined {
  for (const [key, value] of metrics) {
    if (key.startsWith(prefix)) return value;
  }
  return undefined;
}

function findHistogramQuantile(
  metrics: Map<string, number>,
  name: string,
  quantile: string,
): number | undefined {
  for (const [key, value] of metrics) {
    if (key.startsWith(name) && key.includes(`quantile="${quantile}"`)) {
      return Math.round(value * 1000);
    }
  }
  return undefined;
}

/** Model definition for sampling Coder Prometheus metrics. */
export const model = {
  type: "@twonines/coder-metrics-sampler",
  version: "2026.05.31.1",
  description:
    "Scrapes Prometheus metrics from Coder and writes typed metric snapshots for trend analysis.",
  globalArguments: GlobalArgsSchema,
  resources: {
    sample: {
      description:
        "Prometheus metrics snapshot with key operational indicators",
      schema: MetricsSampleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    scrape: {
      description: "Scrape Prometheus metrics and record a typed sample",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: Record<string, unknown>, context: any) => {
        const metricsUrl = context.globalArgs.metricsUrl;
        context.logger.info("Scraping metrics from {url}", { url: metricsUrl });

        const start = performance.now();
        let scrapeSuccess = false;
        let metrics = new Map<string, number>();
        let error: string | undefined;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const res = await fetch(metricsUrl, { signal: controller.signal });
          clearTimeout(timeout);

          if (res.ok) {
            const text = await res.text();
            metrics = parsePrometheusText(text);
            scrapeSuccess = true;
          } else {
            error = `HTTP ${res.status}`;
          }
        } catch (err) {
          clearTimeout(timeout);
          error = String(err);
        }

        const scrapeDurationMs = Math.round(performance.now() - start);

        const sample = {
          apiRequestsTotal: findMetric(
            metrics,
            "coderd_api_requests_processed_total",
          ),
          apiRequestLatencyP50Ms: findHistogramQuantile(
            metrics,
            "coderd_api_request_latencies_seconds",
            "0.5",
          ),
          apiRequestLatencyP95Ms: findHistogramQuantile(
            metrics,
            "coderd_api_request_latencies_seconds",
            "0.95",
          ),
          workspacesRunning: findMetric(
            metrics,
            'coderd_api_workspace_latest_build_status{status="running"}',
          ),
          workspacesStopped: findMetric(
            metrics,
            'coderd_api_workspace_latest_build_status{status="stopped"}',
          ),
          agentConnectionsTotal: findMetric(
            metrics,
            "coderd_api_workspace_latest_build_status",
          ),
          provisionerJobsActive: findMetric(
            metrics,
            "coderd_provisionerd_jobs_current",
          ),
          scrapeDurationMs,
          scrapeSuccess,
          sampledAt: new Date().toISOString(),
          error,
          rawMetricCount: metrics.size,
        };

        context.logger.info(
          "Scraped {count} metrics in {ms}ms (success={success})",
          { count: metrics.size, ms: scrapeDurationMs, success: scrapeSuccess },
        );

        const handle = await context.writeResource("sample", "current", sample);
        return { dataHandles: [handle] };
      },
    },
  },
};
