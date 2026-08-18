// deno-lint-ignore-file no-explicit-any no-import-prefix
// The report `context` and model-type handles are structurally typed by swamp at
// runtime and no importable type is published for them. Matches the convention in
// this repo (fact-store/_lib/impl.ts, repo-indexer/mod.ts, _lib/sqlite-wasm.ts).
import { z } from "npm:zod@4.4.3";
import { AnalysisResourceSchema } from "./redmine_story_analysis_shared.ts";

function escapeCell(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isOpenStatus(value: unknown): boolean {
  const status = String(value ?? "").toLowerCase();
  return !["closed", "done", "resolved", "complete", "completed"].some((term) =>
    status.includes(term)
  );
}

async function readAnalysis(
  context: any,
): Promise<z.infer<typeof AnalysisResourceSchema> | null> {
  const handle = (context.dataHandles ?? [])[0];
  if (!handle) return null;
  const read = async (modelType: any) => {
    const raw = await context.dataRepository.getContent(
      modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    return raw
      ? AnalysisResourceSchema.parse(JSON.parse(new TextDecoder().decode(raw)))
      : null;
  };
  try {
    return await read(context.modelType);
  } catch {
    try {
      const typeArg = {
        raw: context.modelType,
        toDirectoryPath: () => String(context.modelType),
        toString: () => String(context.modelType),
      };
      return await read(typeArg);
    } catch {
      return null;
    }
  }
}

function renderMarkdown(data: z.infer<typeof AnalysisResourceSchema>): string {
  const facts = data.facts;
  const story = recordValue(facts.story);
  const analysis = data.analysis;
  const tasks = arrayValue(facts.tasks).map(recordValue);
  const taskAnalysis = new Map(
    analysis.openTasks.map((task) => [task.id, task]),
  );
  const mergeRequests = arrayValue(facts.mergeRequests).map(recordValue);

  const lines: string[] = [];
  lines.push(`# Redmine Story #${escapeCell(data.storyId)}`);
  lines.push("");
  lines.push(`- **Status:** ${escapeCell(analysis.status)}`);
  lines.push(`- **Confidence:** ${escapeCell(analysis.confidence)}`);
  lines.push(`- **Redmine status:** ${escapeCell(story.status)}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- ${escapeCell(analysis.summary)}`);
  lines.push("");
  lines.push("## Solved when");
  lines.push(`- ${escapeCell(analysis.solvedWhen)}`);
  lines.push("");

  lines.push("## Progress");
  if (analysis.progress.length === 0) {
    lines.push("- No reliable progress evidence was identified.");
  }
  for (const item of analysis.progress) {
    lines.push(
      `- **${escapeCell(item.label)}:** ${escapeCell(item.detail)}${
        item.evidenceIds.length
          ? ` _(evidence: ${item.evidenceIds.map(escapeCell).join(", ")})_`
          : ""
      }`,
    );
  }
  lines.push("");

  lines.push("## Open tasks");
  const openTasks = tasks.filter((task) => isOpenStatus(task.status));
  if (openTasks.length === 0) {
    lines.push("- None reported by Redmine.");
  } else {
    lines.push(
      "| Task | Status | Utility | Achieved | Remaining | Relevance | Blockers |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const task of openTasks) {
      const id = Number(task.id);
      const item = taskAnalysis.get(id);
      lines.push(
        `| #${escapeCell(id)} | ${escapeCell(task.status)} | ${
          escapeCell(item?.utility ?? "Unknown")
        }` +
          ` | ${escapeCell(item?.achieved ?? "Unknown")}` +
          ` | ${escapeCell(item?.remaining ?? "Unknown")}` +
          ` | ${escapeCell(item?.relevance ?? "unknown")}` +
          ` | ${escapeCell(item?.blockers?.join("; ") ?? "None identified")} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Candidate non-essential tasks");
  const candidates = analysis.openTasks.filter((task) =>
    task.relevance === "possibly_nonessential"
  );
  if (candidates.length === 0) lines.push("- None identified.");
  for (const task of candidates) {
    lines.push(
      `- **Task #${escapeCell(task.id)}:** ${
        escapeCell(task.utility)
      } _(confidence: ${escapeCell(analysis.confidence)})_`,
    );
  }
  lines.push("");

  lines.push("## Related merge requests");
  if (mergeRequests.length === 0) {
    lines.push(
      "- None found in the supplied Story, task, or meeting evidence.",
    );
  } else {
    lines.push(
      "| MR | State | Classification | Draft | Mergeability | Blockers |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const mr of mergeRequests) {
      lines.push(
        `| [${escapeCell(mr.reference)}](${escapeCell(mr.webUrl)}) | ${
          escapeCell(mr.state)
        } | ${escapeCell(mr.classification)}` +
          ` | ${mr.draft ? "yes" : "no"} | ${
            escapeCell(mr.detailedMergeStatus ?? mr.mergeable ?? "unknown")
          }` +
          ` | ${
            escapeCell(
              Array.isArray(mr.blockers) && mr.blockers.length
                ? mr.blockers.join("; ")
                : "None identified",
            )
          } |`,
      );
    }
  }
  lines.push("");

  lines.push("## Risks");
  if (analysis.risks.length === 0) {
    lines.push("- None identified from the available evidence.");
  } else {
    lines.push("| Severity | Risk | Impact | Mitigation |");
    lines.push("|---|---|---|---|");
    for (const risk of analysis.risks) {
      lines.push(
        `| ${escapeCell(risk.severity)} | ${escapeCell(risk.risk)} | ${
          escapeCell(risk.impact)
        } | ${escapeCell(risk.mitigation)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Questions and data gaps");
  const questions = [...analysis.questions, ...analysis.dataGaps];
  if (questions.length === 0) lines.push("- None identified.");
  for (const question of questions) lines.push(`- ${escapeCell(question)}`);
  lines.push("");
  lines.push(
    `_Generated by Bedrock model \`${escapeCell(data.modelId)}\` at ${
      escapeCell(data.generatedAt)
    }._`,
  );
  return lines.join("\n");
}

/**
 * Report `@twonines/redmine-story-report`: renders the analyzer's stored assessment
 * as a Markdown status review — progress, blockers, readiness, remaining work and
 * open questions, each line carrying its evidence citations.
 *
 * Reads the `analysis` resource written by the model rather than re-fetching any
 * source, so it is safe to run repeatedly.
 */
export const report = {
  name: "@twonines/redmine-story-report",
  description:
    "Concise evidence-backed Redmine Story status report with task and MR tables",
  scope: "method" as const,
  labels: ["redmine", "story-status", "evidence", "llm"],
  async execute(
    context: any,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    if (context.methodName !== "analyze") {
      return {
        markdown: "",
        json: { skipped: true, method: context.methodName },
      };
    }
    const data = await readAnalysis(context);
    if (!data) {
      return {
        markdown: "# Redmine Story Status\n\n- Analysis data was unavailable.",
        json: { status: "unknown", dataUnavailable: true },
      };
    }
    return {
      markdown: renderMarkdown(data),
      json: {
        storyId: data.storyId,
        status: data.analysis.status,
        confidence: data.analysis.confidence,
        summary: data.analysis.summary,
        solvedWhen: data.analysis.solvedWhen,
        openTasks: data.analysis.openTasks,
        risks: data.analysis.risks,
        questions: data.analysis.questions,
        dataGaps: data.analysis.dataGaps,
        mergeRequests: data.facts.mergeRequests ?? [],
        citations: data.citations,
        generatedAt: data.generatedAt,
        modelId: data.modelId,
      },
    };
  },
};
