import { renderReview } from "./doc_review_report.ts";

const unavailableFinding = {
  id: "FC-0",
  severity: "low" as const,
  category: "recon",
  description: "No fact-check run",
  resolved: false,
  claim: "",
  section: "meta",
  claimType: "fact",
  status: "unverifiable" as const,
  evidence: "",
  recommendation: "",
};

Deno.test("renderReview reports an unavailable Kiro agent as inconclusive", () => {
  const markdown = renderReview({
    target: "README.md",
    docTitle: "Example",
    ranAt: "2026-08-12T00:00:00.000Z",
    cli: "kiro",
    model: "auto",
    agentAvailable: false,
    completed: false,
    ok: false,
    needsHumanCheck: false,
    summary: "Kiro CLI could not be run; no fact-check performed.",
    counts: {
      verified: 0,
      outdated: 0,
      partiallyTrue: 0,
      incorrect: 0,
      unverifiable: 1,
      questionableAssumption: 0,
    },
    findings: [unavailableFinding],
  });

  if (!markdown.includes("No fact-check ran")) {
    throw new Error("Expected an unavailable-agent report");
  }
  if (!markdown.includes("kiro CLI was unavailable")) {
    throw new Error("Expected the selected CLI in the report");
  }
});

Deno.test("renderReview falls back to historical claudeAvailable", () => {
  const markdown = renderReview({
    target: "README.md",
    docTitle: "Legacy example",
    ranAt: "2026-07-22T00:00:00.000Z",
    claudeAvailable: false,
    completed: false,
    ok: false,
    needsHumanCheck: false,
    summary: "Legacy Claude CLI could not be run.",
    counts: {
      verified: 0,
      outdated: 0,
      partiallyTrue: 0,
      incorrect: 0,
      unverifiable: 1,
      questionableAssumption: 0,
    },
    findings: [unavailableFinding],
  });

  if (!markdown.includes("No fact-check ran")) {
    throw new Error("Historical availability was not honored");
  }
  if (!markdown.includes("claude CLI was unavailable")) {
    throw new Error("Historical data should use the Claude fallback");
  }
});

Deno.test("renderReview includes provider-neutral execution metadata", () => {
  const markdown = renderReview({
    target: "README.md",
    docTitle: "Example",
    ranAt: "2026-08-12T00:00:00.000Z",
    cli: "kiro",
    model: "auto",
    agent: "doc-fact-checker",
    agentAvailable: true,
    completed: true,
    ok: true,
    needsHumanCheck: false,
    durationMs: 42,
    exitCode: 0,
    timedOut: false,
    failureKind: null,
    capabilities: {
      repositoryRead: true,
      webRequested: true,
      webEffective: false,
      webStatus: "unavailable",
    },
    summary: "All repository claims were verified.",
    counts: {
      verified: 1,
      outdated: 0,
      partiallyTrue: 0,
      incorrect: 0,
      unverifiable: 0,
      questionableAssumption: 0,
    },
    findings: [{
      ...unavailableFinding,
      status: "verified" as const,
      description: "Fact-check completed",
      resolved: true,
    }],
  });

  for (
    const expected of [
      "kiro (auto)",
      "Profile:** doc-fact-checker",
      "Duration:** 42 ms",
      "Repository read:** available",
      "Web verification:** requested (unavailable)",
      "PASS",
    ]
  ) {
    if (!markdown.includes(expected)) {
      throw new Error(
        `Expected execution metadata was not rendered: ${expected}`,
      );
    }
  }
});

Deno.test("renderReview shows timeout and capability details as inconclusive", () => {
  const markdown = renderReview({
    target: "README.md",
    docTitle: "Timed out",
    ranAt: "2026-08-12T00:00:00.000Z",
    cli: "kiro",
    model: "auto",
    agent: "doc-fact-checker",
    agentAvailable: true,
    completed: false,
    ok: false,
    needsHumanCheck: true,
    durationMs: 600000,
    exitCode: null,
    timedOut: true,
    failureKind: "timeout",
    capabilities: {
      repositoryRead: true,
      webRequested: true,
      webEffective: false,
      webStatus: "unavailable",
    },
    summary: "Kiro CLI timed out before returning a result.",
    counts: {
      verified: 0,
      outdated: 0,
      partiallyTrue: 0,
      incorrect: 0,
      unverifiable: 1,
      questionableAssumption: 0,
    },
    findings: [unavailableFinding],
  });

  for (
    const expected of [
      "INCONCLUSIVE",
      "kiro CLI timed out",
      "Failure:** `timeout`",
      "Timed out:** yes",
      "Web verification:** requested (unavailable)",
    ]
  ) {
    if (!markdown.includes(expected)) {
      throw new Error(
        `Expected timeout metadata was not rendered: ${expected}`,
      );
    }
  }
});
