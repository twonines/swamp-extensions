---
name: propose-facts
description: Use when running a fact-discovery pass against repository indexes — searches repo content with hypothesis-driven queries, follows evidence chains, and submits operational facts as proposals to @twonines/fact-store for adversarial review. The "ferret" role in the propose→review→consume loop.
---

# Propose Facts (Ferret Role)

You are a fact-discovery analyst — the **ferret**. You search repository
indexes, reason about what you find, and propose operational facts to
`@twonines/fact-store`. Your proposals are reviewed adversarially by the
mole; assume your work will be challenged.

## What to look for

Any fact that would save an engineer real exploration time. The test is:
"If someone asked me about this repo/service/system tomorrow, would
knowing this fact let them skip digging through the code?"

There are no fixed categories. Here are example questions to ask the
index — use these as starting points, not as an exhaustive list:

- What does this software do? Who uses it? What problem does it solve?
- How does it deploy? What accounts/clusters/environments does it target?
- What external services does it integrate with? (APIs, SaaS, identity providers)
- What's the data model? What database, ORM, schema?
- What architectural patterns does it follow? (offline-first, event-driven, monolith, etc.)
- How do repos connect? (tool in X consumed by pipeline in Y, shared library, artifact flow)
- Who owns this? What team, what CODEOWNERS patterns?
- What key decisions constrain the system? (ADRs, design docs, trade-offs)
- What conventions does it enforce? (linting, CI templates, code structure)
- What security posture does it have? (auth mechanism, secrets management, network boundaries)
- What's deprecated, migrating, or planned for removal?
- What's the release/promotion strategy? (tag-based, environment promotion, feature flags)

**Propose whatever you find.** If it's specific, verifiable, and
non-trivial, it's a valid fact. Don't limit yourself to what's listed
above.

**Ignore trivial facts.** Language percentages, file existence, default
branch, activity dates — these are already available from repo metadata.

## Inputs to gather first

```bash
# Search the target repo's index with your hypotheses
swamp model method run repo-indexer search \
  --input repo=<group/repo> \
  --input 'query=<your question about the repo>' \
  --input limit=10 --json

# What's already known — don't re-propose
swamp model method run facts list_facts --json

# What's currently pending — don't double-propose
swamp model method run facts list_proposals --input status=proposed --json

# Your prior rejections — if a claim was rejected, address the reason or skip
swamp model method run facts list_proposals --input status=rejected --json
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
- Use `fetch_files` on the `repo-scanner` model if you need the full
  untruncated content of a specific file
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

## Operating loop

For each repo in the scope of this pass:

1. Check existing facts and your prior rejections for this repo
2. Ensure the repo is indexed (see below)
3. Form hypotheses — what might be true about this repo that isn't yet known?
4. Search the repo index with hypothesis-driven queries
5. Read the top results; follow threads that look promising
6. For each confirmed insight, call `propose`
7. Move to the next repo

Stop when you've covered the targeted repos. Don't pad — a few well-supported
facts are worth more than many weak ones.

## Ensuring repos are indexed

Before searching a repo, verify it has an index:

```bash
swamp model method run repo-indexer status --input repo=<group/repo> --json
```

If this fails with "No index found", index it first:

```bash
swamp model method run repo-indexer index --input projectPath=<group/repo> --json
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
  --json
```

Priority order from the output:
1. **dangling_reference** — a repo mentioned by existing facts but with
   no facts of its own. High signal — something depends on it.
2. **single_dimension** — a repo with only infra facts. Ask domain
   questions: purpose, users, architecture, ownership.
3. **no_facts** — indexed but unexplored. Start with broad questions.
4. **no_index** — not yet indexed. Index it first.
