/**
 * Report: @twonines/cribl-health-digest (workflow scope).
 *
 * Consumes the `cribl-health-digest` workflow's per-worker-group `health`,
 * `list_notifications`, and `get_log_lines` steps, plus a single org-wide
 * `check_status_page` step, and correlates them instead of just listing
 * them.
 *
 * The correlation that matters most: Cribl's own health check and
 * notification feed can both stay green/silent while cribl.log shows a real
 * runtime failure (this happened for real -- a burst of "Secret decrypt
 * failed" errors that never surfaced as a health warning or a notification,
 * and only showed up in the log). Any worker group where health/
 * notifications look fine but the log scan found a hit gets flagged
 * explicitly, not just listed alongside the clean ones.
 *
 * The worker group per step is parsed from the resolved step name
 * (`health-default`, `log-scan-acceptance`, ...) rather than
 * `step.methodArgs.workerGroup` -- in practice methodArgs comes back empty
 * for most step types, populated only for get_log_lines. Step names are
 * reliable: the workflow's forEach always appends the worker group as the
 * final `-`-separated segment.
 *
 * @module
 */

interface DataHandle {
  name: string;
  attributes?: Record<string, unknown>;
}

interface StepExecution {
  jobName?: string;
  stepName?: string;
  methodName?: string;
  status?: string;
  dataHandles?: DataHandle[];
}

interface WorkflowReportContext {
  workflowName?: string;
  workflowStatus?: string;
  stepExecutions?: StepExecution[];
}

function firstAttributesOf(
  step: StepExecution | undefined,
): Record<string, unknown> | null {
  const handle = step?.dataHandles?.find((h) =>
    !h.name.startsWith("report-") && h.attributes
  );
  return handle?.attributes ?? null;
}

/** The workflow's forEach step names always end in `-{workerGroup}`. */
function workerGroupFromStepName(
  stepName: string | undefined,
  prefix: string,
): string | null {
  if (!stepName || !stepName.startsWith(`${prefix}-`)) return null;
  return stepName.slice(prefix.length + 1);
}

interface WorkerGroupRow {
  workerGroup: string;
  healthOverall: string | null;
  healthFailed: boolean;
  notificationCount: number | null;
  notificationsFailed: boolean;
  logHits: Record<string, unknown>[];
  logScanFailed: boolean;
  silentAlerting: boolean;
  requiresAttention: boolean;
}

/** Correlates the cribl-health-digest workflow's per-worker-group and status-page steps. */
export const report = {
  name: "@twonines/cribl-health-digest",
  description:
    "Correlates the cribl-health-digest workflow's per-worker-group health/notifications/log-scan " +
    "steps and the org-wide status-page check into one summary, flagging worker groups where " +
    "health and notifications stayed quiet despite a real hit in the log scan.",
  scope: "workflow" as const,
  labels: ["cribl", "observability", "troubleshooting"],

  execute(
    context: WorkflowReportContext,
  ): { markdown: string; json: Record<string, unknown> } {
    const generatedAt = new Date().toISOString();
    const steps = context.stepExecutions ?? [];

    const workerGroups = new Set<string>();
    for (const step of steps) {
      const wg = workerGroupFromStepName(step.stepName, "health") ??
        workerGroupFromStepName(step.stepName, "notifications") ??
        workerGroupFromStepName(step.stepName, "log-scan");
      if (wg) workerGroups.add(wg);
    }

    const rows: WorkerGroupRow[] = [];
    for (const wg of workerGroups) {
      const healthStep = steps.find((s) => s.stepName === `health-${wg}`);
      const notificationsStep = steps.find((s) =>
        s.stepName === `notifications-${wg}`
      );
      const logStep = steps.find((s) => s.stepName === `log-scan-${wg}`);

      const health = firstAttributesOf(healthStep);
      const notifications = firstAttributesOf(notificationsStep);
      const logLines = firstAttributesOf(logStep);

      const healthOverall = typeof health?.overall === "string"
        ? health.overall
        : null;
      const notificationCount = typeof notifications?.count === "number"
        ? notifications.count
        : null;
      const logHits = Array.isArray(logLines?.events)
        ? (logLines!.events as Record<string, unknown>[])
        : [];

      const silentAlerting = healthOverall !== null &&
        healthOverall !== "healthy" &&
        notificationCount === 0;
      const requiresAttention = silentAlerting || healthOverall === "error" ||
        logHits.length > 0;

      rows.push({
        workerGroup: wg,
        healthOverall,
        healthFailed: healthStep?.status === "failed" || health === null,
        notificationCount,
        notificationsFailed: notificationsStep?.status === "failed" ||
          notifications === null,
        logHits,
        logScanFailed: logStep?.status === "failed" || logLines === null,
        silentAlerting,
        requiresAttention,
      });
    }

    const statusPageStep = steps.find((s) =>
      s.methodName === "check_status_page"
    );
    const statusPage = firstAttributesOf(statusPageStep);
    const statusIndicator = typeof statusPage?.indicator === "string"
      ? statusPage.indicator
      : null;
    const statusUnresolved = Array.isArray(statusPage?.unresolvedIncidents)
      ? (statusPage!.unresolvedIncidents as Record<string, unknown>[])
      : [];

    const anyRowNeedsAttention = rows.some((r) => r.requiresAttention);
    const requiresAttention = anyRowNeedsAttention ||
      (statusIndicator !== null && statusIndicator !== "none");

    const lines: string[] = [];
    lines.push(`# Cribl health digest`);
    lines.push("");
    lines.push(`Generated ${generatedAt}.`);
    lines.push("");
    lines.push(
      requiresAttention
        ? "**Requires attention** — see flagged rows below."
        : "No issues found across health, notifications, log scan, or the Cribl status page.",
    );
    lines.push("");
    lines.push("| Worker group | Health | Notifications | Log hits | Flag |");
    lines.push("|---|---|---|---|---|");
    for (
      const r of rows.sort((a, b) => a.workerGroup.localeCompare(b.workerGroup))
    ) {
      const healthCell = r.healthFailed
        ? "fetch failed"
        : r.healthOverall ?? "unknown";
      const notifCell = r.notificationsFailed
        ? "fetch failed"
        : String(r.notificationCount ?? "unknown");
      const logCell = r.logScanFailed
        ? "fetch failed"
        : String(r.logHits.length);
      const flag = r.silentAlerting
        ? "**silent alerting** — health/notifications missed a log-visible problem"
        : r.requiresAttention
        ? "**needs review**"
        : "—";
      lines.push(
        `| ${r.workerGroup} | ${healthCell} | ${notifCell} | ${logCell} | ${flag} |`,
      );
    }
    lines.push("");

    for (const r of rows) {
      if (r.logHits.length === 0) continue;
      lines.push(`## Log hits — ${r.workerGroup}`);
      lines.push("");
      for (const event of r.logHits.slice(0, 20)) {
        const time = typeof event.time === "string"
          ? event.time
          : "unknown time";
        const channel = typeof event.channel === "string"
          ? event.channel
          : "unknown channel";
        const message = typeof event.message === "string"
          ? event.message
          : JSON.stringify(event);
        lines.push(`- \`${time}\` **${channel}** — ${message}`);
      }
      if (r.logHits.length > 20) {
        lines.push(`- ...and ${r.logHits.length - 20} more`);
      }
      lines.push("");
    }

    lines.push(`## Cribl status page`);
    lines.push("");
    if (statusPage === null) {
      lines.push("Status page check failed or produced no data.");
    } else {
      lines.push(
        `Indicator: **${statusIndicator}** — ${
          String(statusPage.description ?? "")
        }`,
      );
      if (statusUnresolved.length > 0) {
        lines.push("");
        lines.push("Unresolved incidents:");
        for (const incident of statusUnresolved) {
          lines.push(
            `- ${String(incident.name ?? incident.id ?? "unnamed incident")}`,
          );
        }
      }
    }

    return {
      markdown: lines.join("\n"),
      json: {
        generatedAt,
        requiresAttention,
        workerGroups: rows,
        statusPage: {
          indicator: statusIndicator,
          unresolvedIncidentCount: statusUnresolved.length,
        },
      },
    };
  },
};
