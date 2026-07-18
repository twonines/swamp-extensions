/**
 * Web Crawl Evaluator — reads article candidates and produces assessments.
 *
 * The evaluate method fetches article content, reads it, and produces an
 * opinionated assessment with a recommendation score. The feedback method
 * records which articles the user actually engaged with, updating learned
 * preferences that influence future evaluations.
 *
 * This model is designed to be invoked by an AI agent that brings genuine
 * engagement to the reading — not just keyword extraction. The agent's
 * assessment text should reflect whether the article was worth reading and
 * why, not just summarize its contents.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { z } from "npm:zod@4";

type Ctx = any;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AssessmentSchema = z.object({
  articleId: z.string(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  score: z.number().min(1).max(10).describe(
    "Recommendation score: 1 = skip, 5 = interesting, 10 = must-read.",
  ),
  recommendation: z.enum(["must_read", "worth_reading", "skim", "skip"])
    .describe("Quick classification for the report."),
  reaction: z.string().describe(
    "The evaluator's genuine reaction — why this article matters or doesn't. Not a summary. Voice and opinion encouraged.",
  ),
  topics: z.array(z.string()).describe(
    "Key topics/themes for preference learning.",
  ),
  readTime: z.string().optional().describe(
    "Estimated read time (e.g., '5 min', '12 min').",
  ),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  evaluatedAt: z.string(),
});

const PreferencesSchema = z.object({
  topicWeights: z.record(z.string(), z.number()).describe(
    "Topic -> interest weight (-1.0 to 1.0). Positive = interested, negative = not interested.",
  ),
  sourceWeights: z.record(z.string(), z.number()).describe(
    "Source -> reliability weight (0.0 to 1.0). Higher = more trusted.",
  ),
  authorWeights: z.record(z.string(), z.number()).describe(
    "Author -> interest weight (-1.0 to 1.0).",
  ),
  feedbackCount: z.number(),
  updatedAt: z.string(),
});

type Assessment = z.infer<typeof AssessmentSchema>;

// ---------------------------------------------------------------------------
// Content Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch readable text content from a URL. Best-effort extraction.
 * Returns the raw text (stripped of HTML) or null if fetch fails.
 */
async function fetchContent(
  url: string,
  logger: any,
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; swamp-web-crawl/1.0; +https://codeberg.org/twonines/swamp-extensions)",
        "Accept": "text/html,application/xhtml+xml,text/plain",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      logger.warn("Fetch {url} returned {status}", {
        url,
        status: resp.status,
      });
      return null;
    }
    const contentType = resp.headers.get("content-type") || "";
    const text = await resp.text();

    if (contentType.includes("text/plain")) return text;

    // Extract readable content from HTML
    return extractReadableText(text);
  } catch (err) {
    logger.warn("Fetch failed for {url}: {error}", {
      url,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Minimal HTML-to-text extraction. Targets article/main content,
 * strips nav/header/footer/script/style, returns prose.
 */
function extractReadableText(html: string): string {
  // Remove script, style, nav, header, footer
  let text = html.replace(
    /<(script|style|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );

  // Try to find article or main content
  const articleMatch = text.match(
    /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i,
  );
  if (articleMatch) text = articleMatch[2];

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Limit to ~10k chars (enough for evaluation without blowing context)
  return text.slice(0, 10_000);
}

// ---------------------------------------------------------------------------
// Model Export
// ---------------------------------------------------------------------------

/**
 * Swamp extension model: Web Crawl Evaluator.
 * Reads harvested candidates, records agent-provided assessments, manages
 * learned interest preferences from user feedback, and adjusts scores
 * based on accumulated preference signals.
 */
export const model = {
  type: "@twonines/web-crawl/evaluator",
  version: "2026.07.18.1",

  globalArguments: z.object({
    harvesterModelId: z.string().default("").describe(
      "Model ID or name of the harvester instance to read candidates from. Empty = find any @twonines/web-crawl/harvester.",
    ),
    maxArticles: z.number().min(1).max(50).default(20).describe(
      "Maximum articles to evaluate per run.",
    ),
  }),

  resources: {
    assessments: {
      description:
        "Evaluated articles with scores, reactions, and recommendations.",
      schema: z.object({
        runId: z.string(),
        evaluatedAt: z.string(),
        assessments: z.array(AssessmentSchema),
        totalEvaluated: z.number(),
        recommended: z.number(),
      }),
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
    preferences: {
      description: "Learned user interest preferences from feedback signals.",
      schema: PreferencesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    evaluate: {
      description:
        "Read the latest harvest candidates, fetch their content, and produce assessments with scores and reactions. The calling agent should provide genuine engagement — not just summaries.",
      arguments: z.object({
        harvestId: z.string().optional().describe(
          "Specific harvest run to evaluate. If omitted, uses the most recent.",
        ),
        assessments: z.array(AssessmentSchema).describe(
          "The agent's assessments of the articles. The agent reads the content (provided via context or fetched) and fills these in.",
        ),
      }),
      async execute(
        args: { harvestId?: string; assessments: Assessment[] },
        context: Ctx,
      ) {
        const logger = context.logger;
        const now = new Date().toISOString();
        const runId = `eval-${Date.now().toString(36)}`;

        logger.info("Recording {count} assessments", {
          count: args.assessments.length,
        });

        // Load preferences to adjust scores
        let prefs: z.infer<typeof PreferencesSchema> | null = null;
        try {
          prefs = await context.readResource?.("preferences", "main");
        } catch {
          // No preferences yet
        }

        // Apply preference boosts to scores
        const adjusted = args.assessments.map((a) => {
          if (!prefs) return a;
          let boost = 0;
          for (const topic of a.topics) {
            const w = prefs.topicWeights[topic.toLowerCase()];
            if (w) boost += w * 2; // ±2 points max per strong topic signal
          }
          if (a.source && prefs.sourceWeights[a.source]) {
            boost += prefs.sourceWeights[a.source];
          }
          if (a.author && prefs.authorWeights[a.author]) {
            boost += prefs.authorWeights[a.author];
          }
          const adjusted = Math.max(1, Math.min(10, a.score + boost));
          return { ...a, score: Math.round(adjusted * 10) / 10 };
        });

        // Sort by score descending
        adjusted.sort((a, b) => b.score - a.score);

        const recommended =
          adjusted.filter((a) =>
            a.recommendation === "must_read" ||
            a.recommendation === "worth_reading"
          ).length;

        const handle = await context.writeResource("assessments", runId, {
          runId,
          evaluatedAt: now,
          assessments: adjusted,
          totalEvaluated: adjusted.length,
          recommended,
        });

        return { dataHandles: [handle] };
      },
    },

    fetch_content: {
      description:
        "Fetch readable text from a list of URLs. Utility method for agents that want to read article content before producing assessments.",
      arguments: z.object({
        urls: z.array(z.string().url()).max(20).describe(
          "URLs to fetch content from.",
        ),
      }),
      async execute(args: { urls: string[] }, context: Ctx) {
        const logger = context.logger;
        const results: Array<{ url: string; content: string | null }> = [];

        for (const url of args.urls) {
          const content = await fetchContent(url, logger);
          results.push({ url, content });
        }

        const fetched = results.filter((r) => r.content !== null).length;
        logger.info("Fetched content from {fetched}/{total} URLs", {
          fetched,
          total: args.urls.length,
        });

        // Return content inline (not as a resource — ephemeral for the agent)
        return { content: results };
      },
    },

    feedback: {
      description:
        "Record user feedback on articles to update learned preferences. Call after a user reads or skips recommended articles.",
      arguments: z.object({
        signals: z.array(
          z.object({
            articleId: z.string(),
            action: z.enum(["interested", "not_relevant", "read_later"])
              .describe("User's engagement signal."),
            topics: z.array(z.string()).optional().describe(
              "Topics from the article (for preference learning).",
            ),
            source: z.string().optional(),
            author: z.string().optional(),
          }),
        ).describe("Batch of feedback signals."),
      }),
      async execute(
        args: {
          signals: Array<{
            articleId: string;
            action: string;
            topics?: string[];
            source?: string;
            author?: string;
          }>;
        },
        context: Ctx,
      ) {
        const logger = context.logger;
        const now = new Date().toISOString();

        // Load existing preferences
        let prefs: z.infer<typeof PreferencesSchema>;
        try {
          prefs = await context.readResource?.("preferences", "main");
          if (!prefs) throw new Error("no prefs");
        } catch {
          prefs = {
            topicWeights: {},
            sourceWeights: {},
            authorWeights: {},
            feedbackCount: 0,
            updatedAt: now,
          };
        }

        // Learning rate decays with more feedback (stabilize over time)
        const lr = Math.max(0.05, 0.3 / Math.sqrt(prefs.feedbackCount + 1));

        for (const signal of args.signals) {
          const direction = signal.action === "interested"
            ? 1
            : signal.action === "not_relevant"
            ? -0.5
            : 0; // read_later is neutral

          if (direction === 0) continue;

          // Update topic weights
          if (signal.topics) {
            for (const topic of signal.topics) {
              const key = topic.toLowerCase();
              const current = prefs.topicWeights[key] || 0;
              prefs.topicWeights[key] = clamp(
                current + direction * lr,
                -1,
                1,
              );
            }
          }

          // Update source weights
          if (signal.source) {
            const current = prefs.sourceWeights[signal.source] || 0.5;
            prefs.sourceWeights[signal.source] = clamp(
              current + direction * lr * 0.5,
              0,
              1,
            );
          }

          // Update author weights
          if (signal.author) {
            const current = prefs.authorWeights[signal.author] || 0;
            prefs.authorWeights[signal.author] = clamp(
              current + direction * lr,
              -1,
              1,
            );
          }
        }

        prefs.feedbackCount += args.signals.length;
        prefs.updatedAt = now;

        logger.info("Recorded {count} feedback signals (total: {total})", {
          count: args.signals.length,
          total: prefs.feedbackCount,
        });

        const handle = await context.writeResource(
          "preferences",
          "main",
          prefs,
        );
        return { dataHandles: [handle] };
      },
    },

    generate_report: {
      description:
        "Generate an HTML reading list report from the most recent assessments. Writes the HTML to a file artifact.",
      arguments: z.object({
        runId: z.string().optional().describe(
          "Specific evaluation run to report on. If omitted, uses the most recent.",
        ),
        title: z.string().default("Reading List").describe(
          "Title for the HTML report page.",
        ),
        outputPath: z.string().optional().describe(
          "Local file path to also write the HTML to (in addition to the swamp file artifact).",
        ),
      }),
      async execute(
        args: { runId?: string; title: string; outputPath?: string },
        context: Ctx,
      ) {
        const logger = context.logger;

        // Read the most recent assessments
        let data: any = null;
        if (args.runId) {
          try {
            data = await context.readResource?.("assessments", args.runId);
          } catch {
            logger.warn("Could not read assessments for runId {runId}", {
              runId: args.runId,
            });
          }
        }
        // If no specific run or read failed, try to find the latest
        if (!data) {
          try {
            data = await context.readLatestResource?.("assessments");
          } catch {
            // fall through
          }
        }

        if (!data?.assessments || data.assessments.length === 0) {
          return {
            content: {
              html: null,
              message: "No assessments found to report on.",
            },
          };
        }

        const assessments = data.assessments;
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

        const html = renderReportHTML(args.title, dateStr, recommended, rest);

        // Write as file artifact
        if (context.writeFile) {
          await context.writeFile("report", "reading-list.html", html);
        }

        // Also write to local path if specified
        if (args.outputPath) {
          await Deno.writeTextFile(args.outputPath, html);
          logger.info("Wrote HTML report to {path}", {
            path: args.outputPath,
          });
        }

        logger.info(
          "Report generated: {recommended} recommended, {total} total",
          { recommended: recommended.length, total: assessments.length },
        );

        return {
          content: {
            recommended: recommended.length,
            total: assessments.length,
            outputPath: args.outputPath || null,
          },
        };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// HTML Report Rendering
// ---------------------------------------------------------------------------

function renderReportHTML(
  title: string,
  date: string,
  recommended: any[],
  rest: any[],
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — ${esc(date)}</title>
  <style>
    :root {
      --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --accent: #b45309;
      --border: #e7e5e4; --card-bg: #ffffff;
      --score-high: #15803d; --score-mid: #b45309; --score-low: #78716c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e; --accent: #f59e0b;
        --border: #44403c; --card-bg: #292524;
        --score-high: #4ade80; --score-mid: #fbbf24; --score-low: #a8a29e;
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem 1rem; max-width: 48rem; margin: 0 auto; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .date { color: var(--muted); font-size: 0.9rem; margin-bottom: 2rem; }
    .section-title { font-size: 1.1rem; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em; margin: 2.5rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
    .article { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
    .article-header { display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.5rem; }
    .score { font-weight: 700; font-size: 1.1rem; min-width: 2rem; text-align: center; padding: 0.1rem 0.4rem; border-radius: 0.25rem; flex-shrink: 0; }
    .score-high { color: var(--score-high); }
    .score-mid { color: var(--score-mid); }
    .score-low { color: var(--score-low); }
    .article-title { font-size: 1rem; font-weight: 600; line-height: 1.3; }
    .article-title a { color: var(--fg); text-decoration: none; }
    .article-title a:hover { text-decoration: underline; }
    .article-meta { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.5rem; }
    .article-meta span + span::before { content: " · "; }
    .reaction { font-size: 0.9rem; color: var(--fg); line-height: 1.5; font-style: italic; }
    .badge { display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.15rem 0.4rem; border-radius: 0.25rem; background: var(--border); color: var(--muted); margin-right: 0.25rem; }
    .badge-must-read { background: #dcfce7; color: #15803d; }
    .badge-worth-reading { background: #fef3c7; color: #92400e; }
    @media (prefers-color-scheme: dark) { .badge-must-read { background: #14532d; color: #4ade80; } .badge-worth-reading { background: #451a03; color: #fbbf24; } }
    .empty { color: var(--muted); font-style: italic; padding: 2rem 0; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted); }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="date">${esc(date)}</p>
  <div class="section-title">Read These</div>
  ${
    recommended.length > 0
      ? recommended.map(renderCard).join("\n  ")
      : '<p class="empty">Nothing compelling enough to push today.</p>'
  }
  <div class="section-title">What I Read</div>
  ${
    rest.length > 0
      ? rest.map(renderCard).join("\n  ")
      : '<p class="empty">Nothing else evaluated this run.</p>'
  }
  <footer>Generated by <strong>@twonines/web-crawl</strong> · ${
    recommended.length + rest.length
  } articles evaluated</footer>
</body>
</html>`;
}

function renderCard(a: any): string {
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
  if (a.source) meta.push(`<span>${esc(a.source)}</span>`);
  if (a.author) meta.push(`<span>${esc(a.author)}</span>`);
  if (a.readTime) meta.push(`<span>${esc(a.readTime)}</span>`);
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
    esc(a.title)
  }</a></div>
        <div class="article-meta">${meta.join("")}</div>
      </div>
    </div>
    ${a.reaction ? `<div class="reaction">${esc(a.reaction)}</div>` : ""}
  </div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
