/** Render a document fact-check as a human-readable markdown review. */

interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  resolved: boolean;
  claim: string;
  section: string;
  claimType: string;
  status: string;
  evidence: string;
  recommendation: string;
}

interface FactCheck {
  target: string;
  docTitle: string;
  ranAt: string;
  cli?: string;
  model?: string;
  agent?: string;
  /** Canonical availability field written by the provider-neutral model. */
  agentAvailable?: boolean;
  /** Historical field accepted only while rendering legacy resources. */
  claudeAvailable?: boolean;
  completed?: boolean;
  ok: boolean;
  needsHumanCheck?: boolean;
  maxDocumentChars?: number;
  documentChars?: number;
  promptChars?: number;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  failureKind?: string | null;
  capabilities?: {
    repositoryRead: boolean;
    webRequested: boolean;
    webEffective: boolean;
    webStatus: "disabled" | "enabled" | "unavailable" | "unknown";
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  summary: string;
  counts: Record<string, number>;
  findings: Finding[];
}

/** Runtime context supplied by Swamp when rendering a method report. */
export interface DocReviewReportContext {
  methodName: string;
  modelType: string;
  modelId: string;
  dataHandles: Array<{ specName: string; name: string; version: number }>;
  dataRepository: {
    getContent: (
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: {
    debug: (message: string, args?: Record<string, unknown>) => void;
    info: (message: string, args?: Record<string, unknown>) => void;
  };
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
};
const STATUS_ICON: Record<string, string> = {
  verified: "✅",
  outdated: "🕒",
  "partially-true": "🟡",
  incorrect: "❌",
  unverifiable: "❓",
  "questionable-assumption": "🤔",
};
const COUNT_LABELS: Array<[string, string]> = [
  ["incorrect", "Incorrect"],
  ["outdated", "Outdated"],
  ["partiallyTrue", "Partially true"],
  ["questionableAssumption", "Questionable assumption"],
  ["unverifiable", "Unverifiable"],
  ["verified", "Verified"],
];

function icon(map: Record<string, string>, key: string): string {
  return map[key] ?? "•";
}

function hasAgentAvailable(fc: FactCheck): boolean {
  return fc.agentAvailable ?? fc.claudeAvailable ?? false;
}

function executionMetadata(fc: FactCheck): string[] {
  const cli = fc.cli ?? "claude";
  const model = fc.model ?? "unknown";
  const lines = [`- **Agent:** ${cli} (${model})`];
  if (fc.agent) lines.push(`- **Profile:** ${fc.agent}`);
  if (fc.durationMs !== undefined) {
    lines.push(`- **Duration:** ${fc.durationMs} ms`);
  }
  if (fc.exitCode !== undefined) {
    lines.push(
      `- **Exit code:** ${
        fc.exitCode === null ? "not available" : fc.exitCode
      }`,
    );
  }
  if (fc.timedOut !== undefined) {
    lines.push(`- **Timed out:** ${fc.timedOut ? "yes" : "no"}`);
  }
  if (fc.capabilities) {
    lines.push(
      `- **Repository read:** ${
        fc.capabilities.repositoryRead ? "available" : "unavailable"
      }`,
      `- **Web verification:** ${
        fc.capabilities.webRequested ? "requested" : "not requested"
      } (${fc.capabilities.webStatus})${
        fc.capabilities.webEffective ? " — effective" : ""
      }`,
    );
  }
  if (fc.failureKind) lines.push(`- **Failure:** \`${fc.failureKind}\``);
  if (fc.usage) {
    const usage = Object.entries(fc.usage)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    if (usage) lines.push(`- **Usage:** ${usage}`);
  }
  return lines;
}

function inconclusiveMessage(fc: FactCheck, cli: string): string {
  switch (fc.failureKind) {
    case "profile-unsafe":
      return `The ${cli} agent profile was rejected as unsafe.`;
    case "cli-unavailable":
      return `The ${cli} CLI was unavailable.`;
    case "timeout":
      return `The ${cli} CLI timed out.`;
    case "output-unparseable":
      return `The ${cli} CLI returned no parseable JSON payload.`;
    case "schema-invalid":
      return `The ${cli} CLI returned an invalid fact-check payload.`;
    case "command-invalid":
      return `The ${cli} invocation was rejected before execution.`;
    case "nonzero-exit":
      return `The ${cli} CLI exited unsuccessfully without a usable result.`;
    default:
      return hasAgentAvailable(fc)
        ? `The ${cli} execution did not produce a usable result.`
        : `The ${cli} CLI was unavailable.`;
  }
}

/** Render one finding. */
function renderFinding(finding: Finding): string {
  const lines = [
    `### ${icon(SEVERITY_ICON, finding.severity)} ${finding.id} — ${
      icon(STATUS_ICON, finding.status)
    } ${finding.status}  ·  _${finding.severity}_`,
    "",
    `**Claim** (${finding.section} · ${finding.claimType}):`,
    "",
    `> ${finding.claim.replace(/\n/g, "\n> ")}`,
    "",
  ];
  if (finding.evidence) lines.push(`**Evidence:** ${finding.evidence}`, "");
  if (finding.recommendation) {
    lines.push(`**Recommendation:** ${finding.recommendation}`, "");
  }
  return lines.join("\n");
}

/** Build the readable markdown review from a fact-check resource. */
export function renderReview(fc: FactCheck): string {
  const agentAvailable = hasAgentAvailable(fc);
  const cli = fc.cli ?? "claude";
  const completed = fc.completed !== false && agentAvailable;
  if (!completed) {
    return [
      `# Fact-check — ${fc.docTitle}`,
      "",
      `> ⚠️ **INCONCLUSIVE — No fact-check ran.** ${
        inconclusiveMessage(fc, cli)
      }`,
      "",
      `- **Document:** \`${fc.target}\``,
      ...executionMetadata(fc),
      "",
      fc.summary ? fc.summary : "_No summary produced._",
    ].join("\n");
  }

  const recon = fc.findings.find((finding) => finding.id === "FC-0");
  const claims = fc.findings.filter((finding) => finding.id !== "FC-0");
  const needsAttention = claims
    .filter((finding) => finding.status !== "verified")
    .sort((a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    );
  const clean = claims.filter((finding) => finding.status === "verified");
  const needsCheck = fc.needsHumanCheck ??
    ((fc.counts.unverifiable ?? 0) +
        (fc.counts.questionableAssumption ?? 0) +
        (fc.counts.partiallyTrue ?? 0) > 0);

  let verdict: string;
  if (!fc.ok) {
    verdict =
      "❌ **NEEDS FIXES** — at least one claim is incorrect or outdated.";
  } else if (needsCheck) {
    verdict =
      "🟡 **PASS, WITH CAVEATS** — no wrong facts, but some claims need a human to confirm.";
  } else {
    verdict = "✅ **PASS** — every checkable claim verified.";
  }

  const breakdown = COUNT_LABELS
    .filter(([key]) => (fc.counts[key] ?? 0) > 0)
    .map(([key, label]) => `${label}: **${fc.counts[key]}**`)
    .join(" · ") || "no claims recorded";
  const output: string[] = [
    `# Fact-check — ${fc.docTitle}`,
    "",
    verdict,
    "",
    `- **Document:** \`${fc.target}\``,
    ...executionMetadata(fc),
    `- **Ran at:** ${fc.ranAt}`,
    `- **Claims assessed:** ${claims.length}`,
    `- **Breakdown:** ${breakdown}`,
    "",
    "## Summary",
    "",
    fc.summary || "_No summary produced._",
    "",
  ];

  if (needsAttention.length > 0) {
    output.push(
      `## Needs attention (${needsAttention.length})`,
      "",
      ...needsAttention.map(renderFinding),
    );
  } else {
    output.push(
      "## Needs attention (0)",
      "",
      "_Every checkable claim verified._",
      "",
    );
  }

  if (clean.length > 0) {
    output.push(
      `## Verified claims (${clean.length})`,
      "",
      "| Section | Type | Claim |",
      "| --- | --- | --- |",
      ...clean.map((finding) =>
        `| ${finding.section} | ${finding.claimType} | ${
          finding.claim.replace(/\|/g, "\\|").replace(/\n/g, " ")
        } |`
      ),
      "",
    );
  }
  if (recon?.description) output.push("---", "", `_${recon.description}_`, "");
  return output.join("\n");
}

/** Swamp report definition for the document fact-check review resource. */
export const report = {
  name: "@twonines/doc-fact-review",
  description:
    "Renders the @twonines/doc-fact-checker fact-check resource as a human-readable review.",
  scope: "method",
  labels: ["docs", "fact-check", "review"],
  execute: async (context: DocReviewReportContext) => {
    if (context.methodName !== "review") {
      return {
        markdown:
          `_@twonines/doc-fact-review only applies to the review method (got ${context.methodName})._`,
        json: { skipped: true, methodName: context.methodName },
      };
    }
    const handle = context.dataHandles.find((item) =>
      item.specName === "fact-check"
    );
    if (!handle) {
      return {
        markdown: "_No fact-check data was produced by this run._",
        json: { error: true, message: "no fact-check data handle" },
      };
    }
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return {
        markdown: "_Fact-check data handle found but its content was missing._",
        json: { error: true, message: "fact-check content missing" },
      };
    }
    const factCheck = JSON.parse(new TextDecoder().decode(raw)) as FactCheck;
    const available = hasAgentAvailable(factCheck);
    const factCheckCli = factCheck.cli ?? "claude";
    const factCheckModel = factCheck.model ?? "unknown";
    const markdown = renderReview(factCheck);
    context.logger.info("Rendered document fact-check review", {
      target: factCheck.target,
      cli: factCheckCli,
      ok: factCheck.ok,
      completed: factCheck.completed ?? null,
      failureKind: factCheck.failureKind ?? null,
      claims: factCheck.findings.length - 1,
    });
    return {
      markdown,
      json: {
        target: factCheck.target,
        docTitle: factCheck.docTitle,
        cli: factCheckCli,
        model: factCheckModel,
        agent: factCheck.agent ?? null,
        agentAvailable: available,
        completed: factCheck.completed ?? null,
        ok: factCheck.ok,
        needsHumanCheck: factCheck.needsHumanCheck ?? null,
        ranAt: factCheck.ranAt,
        durationMs: factCheck.durationMs ?? null,
        exitCode: factCheck.exitCode ?? null,
        timedOut: factCheck.timedOut ?? null,
        failureKind: factCheck.failureKind ?? null,
        capabilities: factCheck.capabilities ?? null,
        usage: factCheck.usage ?? null,
        counts: factCheck.counts,
        summary: factCheck.summary,
      },
    };
  },
};
