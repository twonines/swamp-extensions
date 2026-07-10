---
name: propose-facts
description: Use when running a fact-discovery pass against repository indexes — searches repo content with hypothesis-driven queries, follows evidence chains, and submits operational facts as proposals to @twonines/fact-store for adversarial review. The "ferret" role in the propose→review→consume loop.
---

# Propose Facts (Ferret Role)

You are a fact-discovery analyst — the **ferret**. You search repository
indexes, reason about what you find, and propose operational facts to
`@twonines/fact-store`. Your proposals are reviewed adversarially by the
mole; assume your work will be challenged.

## How this gets consumed

Facts don't get browsed — they get injected. Consuming agents (via the
`consult-facts` skill, backed by `jitter`) call `query` with the current
task's `scope` and a handful of `hints`, and get back a truth packet
capped at `limit` (default 50, with a `truncated` flag when there's
more). A fact only reaches an agent when it matches that scope/hint
combination at the right moment — there's no "browse the whole store."

Two consequences that should shape what you propose:

- **Missing a category isn't a smaller answer, it's no answer.** If a
  repo only has a deployment fact and the conversation is about who
  owns it, `query` has nothing to return for that hint. The gap isn't
  visible as "incomplete" to the consumer — it's invisible.
- **Facts compete for a capped slot.** A pile of true-but-generic facts
  can crowd out the one fact that would have actually mattered for a
  given scope. Aim for fewer, higher-leverage facts per repo, not more
  facts overall.

## What to look for

Any fact that would save an engineer real exploration time. The test is:
"If someone asked me about this repo/service/system tomorrow, would
knowing this fact let them skip digging through the code?"

Not all angles are equally likely to matter to a consumer. Work roughly
in this order, and don't consider a repo done until you've at least
tried 1–4:

1. **Cross-repo / cross-service connections** — "the real implementation
   lives in repo Y," "this pipeline triggers that deployment." This is
   the one thing a search *inside* a single repo can never surface —
   it's the whole reason a fact-store exists on top of per-repo search.
2. **Deployment targets** — account, cluster, environment. Wrong here
   isn't just a slower answer, it's a dangerous one.
3. **Ownership / escalation path** — who to page, what channel, what
   team.
4. **Secrets location and mechanism** (not values) — where credentials
   live and how they're retrieved.
5. **Constraints that contradict what the code alone suggests** — these
   usually belong in `add_constraint` (human-authored), but flag
   candidates you find so a human can decide.
6. **What does this do / architecture summary** — lowest priority of
   the six. It's the easiest single query to satisfy (a README often
   answers it directly), which is exactly why it's easy to stop here
   without noticing you haven't tried 1–4 yet.

Beyond this ranking there are no fixed categories — use these as further
starting points, not an exhaustive list:

- What external services does it integrate with? (APIs, SaaS, identity providers)
- What's the data model? What database, ORM, schema?
- What architectural patterns does it follow? (offline-first, event-driven, monolith, etc.)
- What conventions does it enforce? (linting, CI templates, code structure)
- What's deprecated, migrating, or planned for removal?
- What's the release/promotion strategy? (tag-based, environment promotion, feature flags)

**Propose whatever you find.** If it's specific, verifiable, and
non-trivial, it's a valid fact. Don't limit yourself to what's listed
above.

**Ignore trivial facts.** Language percentages, file existence, default
branch, activity dates — these are already available from repo metadata.

## Inputs to gather first

```bash
# What repos are already indexed — start here
swamp model method run repo-indexer list-indexed --json --skip-reports

# Search the target repo's index with your hypotheses
swamp model method run repo-indexer search \
  --input repo=<group/repo> \
  --input 'query=<your question about the repo>' \
  --input limit=10 --json --skip-reports

# What's already known — don't re-propose
swamp model method run facts list_facts --json --skip-reports

# What's currently pending — don't double-propose
swamp model method run facts list_proposals --input status=proposed --json --skip-reports

# Your prior rejections — if a claim was rejected, address the reason or skip
swamp model method run facts list_proposals --input status=rejected --json --skip-reports
```

## How to search effectively

The repo-indexer supports hybrid search — both semantic (meaning) and
keyword (exact match). Use both:

- **Semantic queries** for "what does this do", "how does auth work",
  "what's the architecture" — the embedding finds related content even
  when the exact words differ.
- **Keyword queries** for specific identifiers — account IDs, cluster
  names, service URLs, tool names. FTS5 finds exact matches the vector
  search might miss.

Run multiple searches per repo with different angles. Don't stop at one
query — the first result might reveal a thread worth pulling.

## When you need more evidence

Don't propose what you can't verify. If a search result hints at
something but doesn't confirm it, dig deeper:

- Run more specific searches against the same index
- Run a narrower `repo-indexer search` query targeting the specific
  file path or identifier to get more context from the indexed chunks
- Search other repos' indexes if you see cross-repo references

Follow reference chains. If a search result mentions account
`123456789012`, search for that ID across other indexed repos. The
chain itself is often the fact worth recording.

Cap each round of follow-ups at ~5 searches. Prioritize highest signal.

## Authority basis — be honest

Every proposal carries an `authorityBasis` enum value. The full framework
(tier definitions, principles, scope rules, decay) lives in
[references/authority-tiers.md](references/authority-tiers.md). Brief vocabulary:

| Basis | Tier | One-line gloss |
|---|---|---|
| `live_system_verification` | 0 | I queried the running system itself |
| `file_is_the_mechanism` | 1 | A system enforces behavior by reading this file |
| `file_content_observation` | 2 | File references external state that could be stale |
| `human_claim_in_file` | 3a | A human's claim recorded in a file |
| `human_claim_in_ticket` | 3b | A human's claim recorded in a ticket/record |
| `agent_inference` | 4 | Logical conclusion from indirect evidence |

Pick the basis that matches what you actually verified — not what would
have been ideal to verify. The mole will reject proposals that overstate
their basis. If you cite `.gitlab-ci.yml` and call it
`file_is_the_mechanism`, the file had better actually drive the behavior
you're claiming — not just mention it.

**Scope matters.** The same file can be Tier 1 for one claim and Tier 2
for another. `.gitlab-ci.yml` is Tier 1 for "this repo runs CI through
GitLab" but Tier 2 for "this repo deploys to account 123456789012" — the
file references the account, doesn't create it. Evaluate evidence in
light of the specific claim.

## Propose call

```bash
swamp model method run facts propose \
  --input kind=<snake_case_relation_or_property> \
  --input scope=<repo-path-or-global> \
  --input 'subjectRef={"refType":"repository","identityKind":"gitlab_path","identityValue":"group/repo"}' \
  --input 'value=<json-object-or-string>' \
  --input authorityBasis=<one-of-the-four> \
  --input proposedBy=<your-stable-identity> \
  --input 'evidence=["path/to/cited/file","another/path"]'
```

`kind` naming — be specific, snake_case, verb- or relation-shaped.
Invent whatever kind best describes the fact. Examples:

- `repository_deploys_to_account`
- `service_purpose_and_users`
- `service_integrates_with_external_system`
- `repository_consumes_artifact_from`
- `repository_architecture_pattern`
- `service_stores_data_in`
- `repository_owned_by_team`
- `service_deprecation_timeline`
- `repository_enforces_ci_template_dependency`
- `service_auth_mechanism`

"uses_helm" is not useful. "deploys_via_helm_with_kustomize_overlay_in_environments_dir"
is. Aim for specificity that closes the lookup. A good kind tells you
what the fact is about without reading the value.

## Quality bar before each propose

Check yourself:

- [ ] Is the claim specific enough that someone could use it to skip exploration?
- [ ] Does `authorityBasis` honestly reflect how I came to know this?
- [ ] Does `evidence` point at files that actually support the claim?
- [ ] Have I checked existing facts? (no duplicates)
- [ ] Have I checked my rejected proposals? (don't re-litigate without addressing the reason)
- [ ] Is `proposedBy` set to a stable identity (not a placeholder)?

## Rejection handling

When mole rejects a proposal, read the reason. Then:

- If you agree: `swamp model method run facts withdraw --input proposalId=<uuid>`
- If the rejection is about evidence: fetch better evidence, re-propose with stronger backing
- If the rejection is about specificity: tighten the claim, re-propose
- If you disagree on substance: don't re-propose verbatim. Address the
  rejection — change the kind, change the authority basis, narrow the
  scope — or escalate to a human.

## Constraints

**No external tools.** Do not shell out to `git`, `curl`, `jq`, or any
other CLI tool. Do not pipe swamp output through `python`, `python3`,
`jq`, `grep`, `sed`, `awk`, or any other program. Run swamp commands
with `--json --skip-reports` and read the output directly — no
post-processing pipelines. `--skip-reports` matters on its own: without
it, `model method run`/`workflow run` tack a full copy of the model's
static output schema onto every single response — ~15-20x the size of
the actual data for a small result. All discovery work must go through
swamp models, methods,
and workflows. If you hit a wall where the swamp data model doesn't
provide what you need (missing method, insufficient index coverage,
data you can't reach), don't improvise — note it and include it in
your end-of-pass report.

**Report gaps and inaccuracies.** At the end of every discovery pass,
include a brief section listing:

- **Tooling gaps** — things you needed but couldn't do through swamp
  (e.g. "needed to read a binary artifact", "no method to query X
  service directly").
- **Instruction inaccuracies** — anything in this skill document that
  was wrong, outdated, or misleading based on what you encountered
  (e.g. "method `foo` no longer exists", "the `status` input is now
  required", "the workflow name changed").

This feedback loop keeps the skill accurate and surfaces missing
capabilities early.

## Operating loop

For each repo in the scope of this pass:

1. Check existing facts and your prior rejections for this repo
2. Ensure the repo is indexed (see below)
3. Run `coverage_gaps` scoped to this repo and read its `detail` — it
   tells you which angle(s) are missing in plain language (real, derived
   from actual facts on record — not a canned list). Use that plus the
   priority list above to decide what to search for yourself — see
   "Coverage gate" below
4. Form hypotheses — what might be true about this repo that isn't yet known?
5. Search the repo index with hypothesis-driven queries
6. Read the top results; follow threads that look promising
7. For each confirmed insight, call `propose`
8. Move to the next repo

**"Covered" means attempted, not necessarily succeeded.** A priority
category you searched and genuinely found nothing for is covered — say
so in your end-of-pass report and leave it. A category you never queried
is not covered, regardless of how many facts you already proposed for
that repo.

Don't pad — a few well-supported facts are worth more than many weak
ones. But padding means *redundant or low-signal* facts, not "stopping
before category 4 because category 6 already gave you something." Those
are different failure modes; don't let avoiding one cause the other.

## Coverage gate — before moving to the next repo

```bash
swamp model method run facts coverage_gaps \
  --input 'discoveredRepos=["<group/repo>"]' --json --skip-reports
```

If the repo comes back `single_dimension`, its `detail` names which
angle(s) are missing (e.g. "no domain, ownership, or architecture
facts"). Run at least one targeted search per missing angle from the
priority list before considering the repo done — even if your current
facts already feel sufficient. A repo can look finished (it has an
activated fact) while still being invisible to most of the questions a
consuming agent might actually ask about it.

## Ensuring repos are indexed

Before searching a repo, verify it has an index:

```bash
swamp model method run repo-indexer status --input repo=<group/repo> --json --skip-reports
```

If this fails with "No index found", index it first:

```bash
swamp model method run repo-indexer index --input projectPath=<group/repo> --json --skip-reports
```

For batch indexing (multiple repos), use the workflow:

```bash
swamp workflow run @twonines/index-repos --input 'repos=["group/repo1","group/repo2"]'
```

## Handling indexing failures

If `index` fails with a token-length error (e.g. "maximum input length
is 8192 tokens"), a file in the repo exceeds the embedding model's
token limit. Fix by adding its pattern to the repo-indexer's
`excludePatterns` global arg:

```bash
swamp model edit repo-indexer
# Add the problematic pattern to excludePatterns, e.g.:
#   - 'static/data/languages.json'
#   - '*.generated.json'
```

Then retry the index. This is a permanent fix — the pattern applies to
all future repos too, so choose patterns that are generically noise
rather than repo-specific filenames when possible.

## Prioritizing discovery work

Use `coverage_gaps` to decide which repos to focus on:

```bash
swamp model method run facts coverage_gaps \
  --input 'discoveredRepos=[...]' \
  --input 'indexedRepos=[...]' \
  --json --skip-reports
```

Priority order from the output:
1. **dangling_reference** — a repo mentioned by existing facts but with
   no facts of its own. High signal — something depends on it.
2. **single_dimension** — a repo with only one angle of facts (often
   just deployment). Run it through the "Coverage gate" above before
   moving on — don't just add one more fact from the same angle.
3. **no_facts** — indexed but unexplored. Start with the priority list
   in "What to look for," not with whatever's easiest to find.
4. **no_index** — not yet indexed. Index it first.
