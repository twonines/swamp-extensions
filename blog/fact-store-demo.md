# Building an Adversarial Knowledge Base for AI Agents

Every time an AI agent touches your infrastructure, it starts from scratch. It reads files, searches repos, follows reference chains — and then the next agent does it all over again. The operational knowledge evaporates between sessions.

We built `@twonines/fact-store` to fix that.

## The Problem: Repeated Discovery

Consider a common scenario: an engineer asks an AI agent "what do you know about how we deploy EKS clusters?" The agent has to:

1. Find the right repos
2. Search through CI configs, Terraform files, helm charts
3. Follow cross-repo references (this repo deploys to *that* account using *this* tool from *another* repo)
4. Piece together the full picture

This takes minutes. And the next time someone asks a related question — or the same question in a different session — the entire process repeats. There's no memory. No accumulation. No shared understanding.

## The Solution: Propose → Review → Consume

`@twonines/fact-store` is a [swamp](https://swamp-club.com) extension that implements a curated knowledge base with a three-role adversarial lifecycle:

### The Ferret (Discovery)

A discovery agent searches repository indexes with hypothesis-driven queries. When it finds something operationally useful — how repos connect, what deploys where, what consumes what — it proposes a fact:

```bash
swamp model method run facts propose \
  --input kind=repository_deploys_to_account \
  --input scope=infra/eks \
  --input 'subjectRef={"refType":"repository","identityKind":"gitlab_path","identityValue":"infra/eks"}' \
  --input 'value={"accountId":"123456789012","mechanism":"terraform with helm charts"}' \
  --input authorityBasis=file_is_the_mechanism \
  --input proposedBy=kiro-ferret \
  --input 'evidence=["k8s_config","services/"]' --json
```

Every proposal carries:
- **A typed kind** — specific enough to close the lookup (`repository_deploys_to_account`, not `uses_cloud`)
- **An authority basis** — how strong the evidence actually is, from "I queried the live system" down to "I inferred this from indirect clues"
- **Cited evidence** — the specific files that support the claim

### The Mole (Review)

An independent reviewer agent verifies each proposal against the raw evidence. It defaults to skepticism — false activations pollute the store, but false rejections are cheap (the ferret can re-propose).

The mole checks four things:

1. **Authority basis honesty** — is `file_is_the_mechanism` actually earned? A `.gitlab-ci.yml` *is* the pipeline. A README *mentioning* the pipeline is not.
2. **Value accuracy** — does the claimed value actually appear in the cited files?
3. **Specificity** — would someone still need to go look at the repo to understand what's happening?
4. **Deduplication** — does this add anything beyond what's already known?

Rejections come with actionable feedback:

```
"Account ID 123456789012 not found in .gitlab-ci.yml — only in
k8s_config which references external state. Authority basis should
be file_content_observation, not file_is_the_mechanism."
```

The ferret can then re-propose with a corrected basis or better evidence.

### The Consumer (Query)

Any agent about to do engineering work queries the store first:

```bash
swamp model method run facts query \
  --input scope=infra/eks \
  --input 'hints=["eks","cluster","deploy"]' \
  --json
```

And gets back a truth packet — all reviewed facts and constraints relevant to that scope, ranked by evidence tier. Here's what that looks like in practice:

![A consumer agent answering "what do you know about how we deploy EKS k8s clusters" — assembling cluster topology, deployment mechanisms, and workload patterns from the fact store in 14 seconds.](demo-consult-facts.png)

Instead of minutes of repo exploration, the agent starts with verified operational knowledge and can immediately act on it.

## The Authority Tier Framework

Not all evidence is equal. The fact-store enforces honest assessment through six tiers:

| Tier | Basis | Meaning |
|------|-------|---------|
| 0 | `live_system_verification` | Queried the running system directly |
| 1 | `file_is_the_mechanism` | A system enforces behavior by reading this file |
| 2 | `file_content_observation` | File references external state that could be stale |
| 3a | `human_claim_in_file` | A human's claim recorded in a file |
| 3b | `human_claim_in_ticket` | A human's claim recorded in a ticket |
| 4 | `agent_inference` | Logical conclusion from indirect evidence |

The same file can be different tiers for different claims. `.gitlab-ci.yml` is Tier 1 for "this repo runs CI through GitLab" but Tier 2 for "this repo deploys to account 123456789012" — the file references the account, but doesn't create it.

This matters because consumers can filter by tier. If you're about to modify infrastructure, you probably want Tier 0-1 facts. If you're onboarding to a new system, Tier 2-3 is fine.

## The Export: Closing the Loop

After the mole activates facts, a workflow materializes them into a local SQLite database with full-text search and vector embeddings:

```bash
swamp workflow run refresh-fact-index
```

This writes `~/.jitter/facts.db` — a portable file that downstream tools can query with sub-100ms hybrid retrieval (BM25 via FTS5 + cosine similarity over embeddings). No network round-trip needed at query time.

## The Last Mile: Injecting Facts into Agent Context

The SQLite database is the interface — how you consume it is up to you. In our implementation, a Go tool called `jitter` handles the last mile. It does more than read rows from a table:

1. A Kiro CLI hook fires at session start, passing the user's prompt to `jitter truth --query "..."` 
2. Jitter opens `~/.jitter/facts.db` and runs the same hybrid retrieval the fact-store uses internally — BM25 full-text search via FTS5 *and* cosine similarity over the pre-computed embedding vectors, fused with Reciprocal Rank Fusion (RRF) to combine both signals
3. It embeds the query on the fly against the same embedding endpoint used at index time, so semantic matches work even when the exact words differ
4. The top-ranked facts and all active constraints are assembled into a truth packet and emitted on stdout
5. The Kiro hook injects that truth packet into the agent's context as a user-prompt preamble

The agent never calls the fact-store directly. It sees relevant operational knowledge pre-loaded in its context before it begins work — cluster topology, deployment mechanisms, ownership, cross-repo dependencies — ranked by evidence strength. From the agent's perspective, it simply *knows things* about the system it's about to touch.

This is a deliberate separation of concerns: the fact-store manages truth, the export materializes it for fast access, and jitter performs real-time relevance retrieval at the moment it matters. Each layer is independently replaceable.

## What Makes This Different

**Adversarial by design.** No single agent can pollute the store. The ferret proposes, the mole challenges. Only evidence-backed facts survive.

**Honest about uncertainty.** The authority tier framework prevents overstated confidence. A file that mentions an account ID is not the same as the live system confirming that account exists.

**Accumulative.** Every discovery pass adds to the shared knowledge. The tenth agent to work on a system benefits from the nine that came before.

**Self-correcting.** The mole's rejections teach the ferret what standards to meet. Constraints (human-authored rules) travel alongside facts to prevent known anti-patterns.

## Getting Started

Install the extensions:

```bash
swamp extension pull @twonines/fact-store
swamp extension pull @twonines/repo-indexer
swamp extension pull @twonines/fact-store-index
```

Create the model instances:

```bash
swamp model create @twonines/fact-store facts
swamp model create @twonines/repo-indexer repo-indexer \
  --global-arg gitlabUrl=https://gitlab.example.com \
  --global-arg gitlabToken='${{ vault.get("secrets", "gitlab-token") }}' \
  --global-arg embedUrl=https://api.openai.com \
  --global-arg embedToken='${{ vault.get("secrets", "openai-key") }}'
```

Index some repos, then run a ferret pass using the shipped skill:

```bash
swamp model method run repo-indexer index --input projectPath=myorg/myrepo
```

The `propose-facts` and `review-proposals` skills ship with the extension and load automatically — they guide agents through the full lifecycle.

## What We Learned

Building this taught us a few things:

1. **Discovery without review is hallucination with citations.** The adversarial step isn't overhead — it's what makes the output trustworthy.

2. **Evidence tiers matter more than confidence scores.** An agent saying "I'm 95% sure" means nothing. An agent saying "this is Tier 1 because the file directly drives the behavior" is verifiable.

3. **The feedback loop is the product.** Ferret reports what it couldn't do. Mole reports what was wrong. Both feed back into better tooling and better skills. The system improves itself.

4. **Exploration is expensive; storage is cheap.** One well-evidenced fact saves minutes of discovery every time someone touches that system. The ROI compounds with every query.
