/**
 * Web Crawl Harvester — fetches article candidates from configurable sources.
 *
 * Supports Hacker News (top/best/new stories), Lobsters (hottest/newest),
 * and standard RSS/Atom feeds. Deduplicates against previously seen URLs
 * and stores fresh candidates for downstream evaluation.
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { z } from "npm:zod@4";

type Ctx = any;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hackernews"),
    feed: z.enum(["top", "best", "new"]).default("top"),
    limit: z.number().min(1).max(100).default(30),
  }),
  z.object({
    type: z.literal("lobsters"),
    feed: z.enum(["hottest", "newest"]).default("hottest"),
    limit: z.number().min(1).max(100).default(30),
  }),
  z.object({
    type: z.literal("rss"),
    url: z.string().url(),
    name: z.string().optional(),
    limit: z.number().min(1).max(100).default(25),
  }),
]);

const CandidateSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  sourceType: z.enum(["hackernews", "lobsters", "rss"]),
  score: z.number().optional(),
  commentCount: z.number().optional(),
  commentUrl: z.string().optional(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  harvestedAt: z.string(),
});

type Source = z.infer<typeof SourceSchema>;
type Candidate = z.infer<typeof CandidateSchema>;

// ---------------------------------------------------------------------------
// Source Fetchers
// ---------------------------------------------------------------------------

const HN_API = "https://hacker-news.firebaseio.com/v0";

async function fetchHN(
  feed: string,
  limit: number,
  logger: any,
): Promise<Candidate[]> {
  const feedMap: Record<string, string> = {
    top: "topstories",
    best: "beststories",
    new: "newstories",
  };
  const endpoint = `${HN_API}/${feedMap[feed] || "topstories"}.json`;
  logger.info("Fetching HN {feed} stories", { feed });

  const resp = await fetch(endpoint);
  if (!resp.ok) {
    logger.warn("HN API returned {status}", { status: resp.status });
    return [];
  }
  const ids: number[] = await resp.json();
  const selected = ids.slice(0, limit);

  const candidates: Candidate[] = [];
  // Fetch in batches of 10 to avoid overwhelming the API
  for (let i = 0; i < selected.length; i += 10) {
    const batch = selected.slice(i, i + 10);
    const items = await Promise.all(
      batch.map(async (id) => {
        try {
          const r = await fetch(`${HN_API}/item/${id}.json`);
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      }),
    );
    for (const item of items) {
      if (!item || item.dead || item.deleted || !item.url) continue;
      candidates.push({
        id: `hn-${item.id}`,
        url: item.url,
        title: item.title || "(untitled)",
        source: "Hacker News",
        sourceType: "hackernews",
        score: item.score,
        commentCount: item.descendants,
        commentUrl: `https://news.ycombinator.com/item?id=${item.id}`,
        author: item.by,
        publishedAt: item.time
          ? new Date(item.time * 1000).toISOString()
          : undefined,
        harvestedAt: new Date().toISOString(),
      });
    }
  }
  return candidates;
}

async function fetchLobsters(
  feed: string,
  limit: number,
  logger: any,
): Promise<Candidate[]> {
  const url = feed === "newest"
    ? "https://lobste.rs/newest.json"
    : "https://lobste.rs/hottest.json";
  logger.info("Fetching Lobsters {feed}", { feed });

  const resp = await fetch(url);
  if (!resp.ok) {
    logger.warn("Lobsters returned {status}", { status: resp.status });
    return [];
  }
  const items: any[] = await resp.json();

  return items.slice(0, limit).filter((item) => item.url).map((item) => ({
    id: `lobsters-${item.short_id}`,
    url: item.url,
    title: item.title,
    source: "Lobsters",
    sourceType: "lobsters" as const,
    score: item.score,
    commentCount: item.comment_count,
    commentUrl: item.comments_url,
    author: item.submitter_user?.username,
    publishedAt: item.created_at,
    tags: item.tags,
    harvestedAt: new Date().toISOString(),
  }));
}

async function fetchRSS(
  url: string,
  name: string | undefined,
  limit: number,
  logger: any,
): Promise<Candidate[]> {
  logger.info("Fetching RSS feed {url}", { url });

  const resp = await fetch(url);
  if (!resp.ok) {
    logger.warn("RSS feed {url} returned {status}", {
      url,
      status: resp.status,
    });
    return [];
  }
  const text = await resp.text();
  const feedName = name || new URL(url).hostname;

  // Simple XML parsing — extract items from RSS or Atom feeds
  const candidates: Candidate[] = [];
  const items = parseRSSItems(text);

  for (const item of items.slice(0, limit)) {
    if (!item.link) continue;
    const id = `rss-${hashString(item.link)}`;
    candidates.push({
      id,
      url: item.link,
      title: item.title || "(untitled)",
      source: feedName,
      sourceType: "rss",
      author: item.author,
      publishedAt: item.pubDate,
      summary: item.description ? item.description.slice(0, 300) : undefined,
      harvestedAt: new Date().toISOString(),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// RSS/Atom Parsing (minimal, no external deps)
// ---------------------------------------------------------------------------

interface FeedItem {
  title?: string;
  link?: string;
  author?: string;
  pubDate?: string;
  description?: string;
}

function parseRSSItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  // Try RSS 2.0 first (<item> elements)
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  if (rssItems.length > 0) {
    for (const raw of rssItems) {
      items.push({
        title: extractTag(raw, "title"),
        link: extractTag(raw, "link") || extractAttr(raw, "link", "href"),
        author: extractTag(raw, "dc:creator") || extractTag(raw, "author"),
        pubDate: extractTag(raw, "pubDate") || extractTag(raw, "dc:date"),
        description: stripHtml(
          extractTag(raw, "description") || "",
        ),
      });
    }
    return items;
  }

  // Try Atom (<entry> elements)
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const raw of atomEntries) {
    items.push({
      title: extractTag(raw, "title"),
      link: extractAttr(raw, "link", "href") || extractTag(raw, "link"),
      author: extractTag(raw, "name"), // nested inside <author><name>
      pubDate: extractTag(raw, "published") || extractTag(raw, "updated"),
      description: stripHtml(
        extractTag(raw, "summary") || extractTag(raw, "content") || "",
      ),
    });
  }
  return items;
}

function extractTag(xml: string, tag: string): string | undefined {
  // Handle CDATA sections
  const cdataRe = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i",
  );
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
}

function extractAttr(
  xml: string,
  tag: string,
  attr: string,
): string | undefined {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit int
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Model Export
// ---------------------------------------------------------------------------

/**
 * Swamp extension model: Web Crawl Harvester.
 * Fetches articles from HN, Lobsters, and RSS/Atom feeds, deduplicates,
 * and stores fresh candidates for downstream evaluation.
 */
export const model = {
  type: "@twonines/web-crawl/harvester",
  version: "2026.07.20.1",

  globalArguments: z.object({
    sources: z.array(SourceSchema).describe(
      "List of sources to harvest from. Each source has a type (hackernews, lobsters, rss) and type-specific config.",
    ),
  }),

  resources: {
    candidates: {
      description:
        "Fresh article candidates harvested from configured sources.",
      schema: z.object({
        harvestId: z.string(),
        harvestedAt: z.string(),
        sourceCount: z.number(),
        candidateCount: z.number(),
        newCount: z.number(),
        candidates: z.array(CandidateSchema),
      }),
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    seen: {
      description:
        "Set of previously seen article URLs for deduplication across runs.",
      schema: z.object({
        urls: z.record(z.string(), z.string()), // url -> first seen ISO date
        count: z.number(),
        updatedAt: z.string(),
      }),
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    harvest: {
      description:
        "Fetch articles from all configured sources, deduplicate against previously seen URLs, and store fresh candidates.",
      arguments: z.object({
        maxTotal: z.number().min(1).max(500).default(100).describe(
          "Maximum total candidates to return across all sources.",
        ),
      }),
      async execute(args: { maxTotal: number }, context: Ctx) {
        const { sources } = context.globalArgs;
        const logger = context.logger;
        const now = new Date().toISOString();
        const harvestId = `harvest-${Date.now().toString(36)}`;

        logger.info("Starting harvest from {count} source(s)", {
          count: sources.length,
        });

        // Fetch from all sources in parallel
        const allCandidates: Candidate[] = [];
        const fetches = sources.map(async (source: Source) => {
          try {
            switch (source.type) {
              case "hackernews":
                return await fetchHN(source.feed, source.limit, logger);
              case "lobsters":
                return await fetchLobsters(source.feed, source.limit, logger);
              case "rss":
                return await fetchRSS(
                  source.url,
                  source.name,
                  source.limit,
                  logger,
                );
            }
          } catch (err) {
            logger.warn("Source fetch failed: {error}", {
              error: (err as Error).message,
            });
            return [];
          }
        });

        const results = await Promise.all(fetches);
        for (const batch of results) {
          allCandidates.push(...batch);
        }

        logger.info("Fetched {total} raw candidates", {
          total: allCandidates.length,
        });

        // Load previously seen URLs for dedup
        let seenUrls: Record<string, string> = {};
        try {
          const existing = await context.readResource?.("seen", "main");
          if (existing?.urls) seenUrls = existing.urls;
        } catch {
          // First run — no seen data yet
        }

        // Deduplicate
        const fresh = allCandidates.filter((c) => !seenUrls[c.url]);
        const limited = fresh.slice(0, args.maxTotal);

        logger.info(
          "After dedup: {fresh} new of {total} total, returning {limited}",
          {
            fresh: fresh.length,
            total: allCandidates.length,
            limited: limited.length,
          },
        );

        // Update seen set
        for (const c of limited) {
          seenUrls[c.url] = now;
        }

        // Prune seen URLs older than 30 days
        const thirtyDaysAgo = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString();
        for (const [url, date] of Object.entries(seenUrls)) {
          if (date < thirtyDaysAgo) delete seenUrls[url];
        }

        // Write resources
        const seenHandle = await context.writeResource("seen", "main", {
          urls: seenUrls,
          count: Object.keys(seenUrls).length,
          updatedAt: now,
        });

        const candidatesHandle = await context.writeResource(
          "candidates",
          harvestId,
          {
            harvestId,
            harvestedAt: now,
            sourceCount: sources.length,
            candidateCount: limited.length,
            newCount: limited.length,
            candidates: limited,
          },
        );

        return { dataHandles: [candidatesHandle, seenHandle] };
      },
    },
  },
};
