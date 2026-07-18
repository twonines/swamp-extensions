/**
 * Web Crawl Report — generates a curated HTML reading page.
 *
 * Two sections:
 *   1. "Read these" — top-ranked recommendations with the evaluator's take
 *   2. "What I read" — full engagement log including lower-scored articles
 *
 * Designed to be opinionated, styled, and actually pleasant to read.
 * Not a corporate newsletter — a curated page from a reader who cares.
 *
 * @module
 */
// deno-lint-ignore-file no-explicit-any

const TEXT_DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// Report Export
// ---------------------------------------------------------------------------

/**
 * Swamp extension report: Web Crawl Reading List.
 * Renders evaluator assessments into a curated HTML page with ranked
 * recommendations and full engagement notes.
 */
export const report = {
  name: "@twonines/web-crawl-report",
  description:
    "Curated HTML reading list with ranked recommendations and engagement notes. Renders assessments from the web-crawl evaluator into a styled page.",
  scope: "workflow" as const,
  labels: ["web", "crawl", "curation", "reading"],

  async execute(context: any) {
    const logger = context.logger;
    logger.info("Generating web crawl report");

    // Collect assessments from workflow step executions
    const assessments: any[] = [];
    for (const step of context.stepExecutions ?? []) {
      if (step.modelType !== "@twonines/web-crawl/evaluator") continue;
      if (step.methodName !== "evaluate") continue;

      for (const handle of step.dataHandles ?? []) {
        const bytes: Uint8Array | null = await context.dataRepository
          .getContent(
            step.modelType,
            step.modelId,
            handle.name,
            handle.version,
          );
        if (!bytes) continue;
        try {
          const data = JSON.parse(TEXT_DECODER.decode(bytes));
          if (data?.assessments) assessments.push(...data.assessments);
        } catch {
          logger.warn("Could not parse evaluator data for {handle}", {
            handle: handle.name,
          });
        }
      }
    }

    if (assessments.length === 0) {
      logger.warn("No assessments found in workflow steps");
      return {
        markdown:
          "# Web Crawl Report\n\nNo articles were evaluated in this run.",
        json: { assessments: [], recommended: 0, total: 0 },
      };
    }

    // Sort by score descending
    assessments.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));

    const recommended = assessments.filter(
      (a: any) =>
        a.recommendation === "must_read" ||
        a.recommendation === "worth_reading",
    );
    const rest = assessments.filter(
      (a: any) =>
        a.recommendation !== "must_read" &&
        a.recommendation !== "worth_reading",
    );

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const markdown = renderMarkdown(dateStr, recommended, rest);

    logger.info(
      "Report generated: {recommended} recommended, {total} total",
      { recommended: recommended.length, total: assessments.length },
    );

    // Write the HTML report as a file artifact
    const htmlContent = renderHTML(dateStr, recommended, rest);
    if (context.writeFile) {
      await context.writeFile("report", "reading-list.html", htmlContent);
    }

    return {
      markdown,
      json: {
        generatedAt: now.toISOString(),
        recommended: recommended.length,
        total: assessments.length,
        htmlGenerated: true,
        assessments,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// HTML Renderer
// ---------------------------------------------------------------------------

function renderHTML(date: string, recommended: any[], rest: any[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reading List — ${escHtml(date)}</title>
  <style>
    :root {
      --bg: #fafaf9;
      --fg: #1c1917;
      --muted: #78716c;
      --accent: #b45309;
      --border: #e7e5e4;
      --card-bg: #ffffff;
      --score-high: #15803d;
      --score-mid: #b45309;
      --score-low: #78716c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1917;
        --fg: #fafaf9;
        --muted: #a8a29e;
        --accent: #f59e0b;
        --border: #44403c;
        --card-bg: #292524;
        --score-high: #4ade80;
        --score-mid: #fbbf24;
        --score-low: #a8a29e;
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      padding: 2rem 1rem;
      max-width: 48rem;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .date {
      color: var(--muted);
      font-size: 0.9rem;
      margin-bottom: 2rem;
    }
    .section-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 2.5rem 0 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .article {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .article-header {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    .score {
      font-weight: 700;
      font-size: 1.1rem;
      min-width: 2rem;
      text-align: center;
      padding: 0.1rem 0.4rem;
      border-radius: 0.25rem;
      flex-shrink: 0;
    }
    .score-high { color: var(--score-high); }
    .score-mid { color: var(--score-mid); }
    .score-low { color: var(--score-low); }
    .article-title {
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.3;
    }
    .article-title a {
      color: var(--fg);
      text-decoration: none;
    }
    .article-title a:hover { text-decoration: underline; }
    .article-meta {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    .article-meta span + span::before {
      content: " · ";
    }
    .reaction {
      font-size: 0.9rem;
      color: var(--fg);
      line-height: 1.5;
      font-style: italic;
    }
    .badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.15rem 0.4rem;
      border-radius: 0.25rem;
      background: var(--border);
      color: var(--muted);
      margin-right: 0.25rem;
    }
    .badge-must-read { background: #dcfce7; color: #15803d; }
    .badge-worth-reading { background: #fef3c7; color: #92400e; }
    @media (prefers-color-scheme: dark) {
      .badge-must-read { background: #14532d; color: #4ade80; }
      .badge-worth-reading { background: #451a03; color: #fbbf24; }
    }
    .empty {
      color: var(--muted);
      font-style: italic;
      padding: 2rem 0;
    }
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.8rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <h1>Reading List</h1>
  <p class="date">${escHtml(date)}</p>

  <div class="section-title">Read These</div>
  ${
    recommended.length > 0
      ? recommended.map((a) => renderArticleCard(a)).join("\n  ")
      : '<p class="empty">Nothing compelling enough to push today.</p>'
  }

  <div class="section-title">What I Read</div>
  ${
    rest.length > 0
      ? rest.map((a) => renderArticleCard(a)).join("\n  ")
      : '<p class="empty">Nothing else evaluated this run.</p>'
  }

  <footer>
    Generated by <strong>@twonines/web-crawl</strong> · ${
    assessmentCount(recommended, rest)
  } articles evaluated
  </footer>
</body>
</html>`;
}

function renderArticleCard(a: any): string {
  const scoreClass = a.score >= 7
    ? "score-high"
    : a.score >= 5
    ? "score-mid"
    : "score-low";
  const badge = a.recommendation === "must_read"
    ? '<span class="badge badge-must-read">must read</span>'
    : a.recommendation === "worth_reading"
    ? '<span class="badge badge-worth-reading">worth reading</span>'
    : "";
  const meta: string[] = [];
  if (a.source) meta.push(`<span>${escHtml(a.source)}</span>`);
  if (a.author) meta.push(`<span>${escHtml(a.author)}</span>`);
  if (a.readTime) meta.push(`<span>${escHtml(a.readTime)}</span>`);
  if (a.commentUrl && a.commentCount !== undefined) {
    meta.push(
      `<span><a href="${
        escAttr(a.commentUrl)
      }" style="color:inherit">${a.commentCount} comments</a></span>`,
    );
  }

  return `<div class="article">
    <div class="article-header">
      <span class="score ${scoreClass}">${a.score?.toFixed?.(0) ?? "?"}</span>
      <div>
        <div class="article-title">${badge}<a href="${escAttr(a.url)}">${
    escHtml(a.title)
  }</a></div>
        <div class="article-meta">${meta.join("")}</div>
      </div>
    </div>
    ${a.reaction ? `<div class="reaction">${escHtml(a.reaction)}</div>` : ""}
  </div>`;
}

function assessmentCount(rec: any[], rest: any[]): number {
  return rec.length + rest.length;
}

// ---------------------------------------------------------------------------
// Markdown Renderer (for swamp report storage)
// ---------------------------------------------------------------------------

function renderMarkdown(date: string, recommended: any[], rest: any[]): string {
  const lines: string[] = [];
  lines.push(`# Reading List — ${date}`);
  lines.push("");
  lines.push(`## Read These (${recommended.length})`);
  lines.push("");
  if (recommended.length === 0) {
    lines.push("_Nothing compelling enough to push today._");
  }
  for (const a of recommended) {
    lines.push(
      `- **[${a.title}](${a.url})** (${a.score}/10) — ${a.source || "unknown"}`,
    );
    if (a.reaction) lines.push(`  > ${a.reaction}`);
    lines.push("");
  }
  lines.push(`## What I Read (${rest.length})`);
  lines.push("");
  if (rest.length === 0) {
    lines.push("_Nothing else evaluated this run._");
  }
  for (const a of rest) {
    lines.push(
      `- [${a.title}](${a.url}) (${a.score}/10) — ${a.source || "unknown"}`,
    );
    if (a.reaction) lines.push(`  > ${a.reaction}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
