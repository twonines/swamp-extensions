# @twonines/web-crawl

Automated web reading pipeline. Harvests articles from configurable sources,
evaluates them with an AI agent, learns your interests over time, and produces
a curated HTML report with ranked recommendations.

## What it does

1. **Harvest** — pulls articles from Hacker News, Lobsters, and/or RSS/Atom
   feeds. Deduplicates against previous runs.
2. **Evaluate** — an AI agent reads the candidates and produces opinionated
   assessments with scores (1–10) and genuine reactions.
3. **Report** — generates a styled HTML page with two sections:
   - *Read These* — top recommendations the agent thinks you should read
   - *What I Read* — everything the agent engaged with, including lower-scored
     articles and honest "this didn't land" notes
4. **Learn** — feedback on which articles you actually read updates preference
   weights, improving future recommendations.

## Quick Start

```bash
swamp extension pull @twonines/web-crawl

# Create model instances
swamp model create @twonines/web-crawl/harvester web-crawl-harvester \
  --global-arg 'sources=[{"type":"hackernews","feed":"top","limit":30},{"type":"lobsters","feed":"hottest","limit":20}]'

swamp model create @twonines/web-crawl/evaluator web-crawl-evaluator

# Run the harvest
swamp model method run web-crawl-harvester harvest

# Agent evaluates (typically via a workflow or agent session)
swamp model method run web-crawl-evaluator evaluate \
  --arg 'assessments=[...]'

# Run the full pipeline
swamp workflow run @twonines/web-crawl-run
```

## Sources

Configure sources via the harvester's `globalArguments.sources` array:

```json
[
  { "type": "hackernews", "feed": "top", "limit": 30 },
  { "type": "lobsters", "feed": "hottest", "limit": 20 },
  { "type": "rss", "url": "https://feeds.arstechnica.com/arstechnica/index", "name": "Ars Technica", "limit": 15 },
  { "type": "rss", "url": "https://quantamagazine.org/feed/", "name": "Quanta", "limit": 10 }
]
```

### Supported source types

| Type | Feeds | Notes |
|------|-------|-------|
| `hackernews` | `top`, `best`, `new` | Uses the Firebase API. Only articles with URLs (skips Ask HN, Show HN text posts). |
| `lobsters` | `hottest`, `newest` | Includes tags from Lobsters taxonomy. |
| `rss` | any URL | Parses RSS 2.0 and Atom feeds. No external dependencies. |

## Evaluation

The evaluator model is designed for **agent-driven** assessment. It doesn't
auto-score articles by keyword — an AI agent reads the content and produces
genuine reactions. The `fetch_content` method is a utility for agents that
want to read article text before evaluating.

### Assessment fields

| Field | Type | Description |
|-------|------|-------------|
| `score` | 1–10 | Recommendation strength |
| `recommendation` | enum | `must_read`, `worth_reading`, `skim`, `skip` |
| `reaction` | string | Why this matters (or doesn't). Voice encouraged. |
| `topics` | string[] | Key themes (used for preference learning) |
| `readTime` | string? | Estimated read time |

## Preference Learning

The `feedback` method records which articles the user engaged with:

```bash
swamp model method run web-crawl-evaluator feedback \
  --arg 'signals=[{"articleId":"hn-12345","action":"interested","topics":["systems","networking"]}]'
```

Actions: `interested`, `not_relevant`, `read_later`

Preferences accumulate over time with a decaying learning rate — early
feedback has stronger effect, later feedback fine-tunes. Topic, source,
and author weights all factor into future score adjustments.

## Report

The HTML report features:
- Dark mode support (respects `prefers-color-scheme`)
- Score badges with color coding (green/amber/grey)
- Article cards with source, author, read time metadata
- Evaluator reactions in italics
- Comment links for HN/Lobsters articles
- Responsive layout, no external dependencies

## Models

| Model | Type | Purpose |
|-------|------|---------|
| Harvester | `@twonines/web-crawl/harvester` | Fetch + dedup articles from sources |
| Evaluator | `@twonines/web-crawl/evaluator` | Agent-driven assessment + preference learning |

## Resources

| Resource | Model | Lifetime | Purpose |
|----------|-------|----------|---------|
| `candidates` | harvester | 7 days | Fresh article candidates |
| `seen` | harvester | 30 days | Dedup URL set |
| `assessments` | evaluator | 30 days | Scored evaluations |
| `preferences` | evaluator | infinite | Learned interest weights |

## License

MIT
