---
name: consult-facts
description: Use before starting engineering work on a repo, service, cluster, account, or ops system — query @twonines/fact-store for existing operational truth, rank facts by evidence tier, and detect drift before it costs discovery time. The "consumer" role that closes the propose→review→consume loop.
---

# Consult Facts (Consumer Role)

You are a fact consumer — the third role in the ferret/mole/consumer
lifecycle. Before doing engineering work on any repo, service, cluster,
account, or ops system, you check what the fact-store already knows.
Facts already reviewed by the mole are cheaper than fresh discovery
every time. Your job is to **assemble a truth packet before you touch a
system, rank what you get by evidence tier, and flag drift the moment
you spot it.**

## When to fire

Trigger on tasks that mention any of the following:

- A specific repo (`o11n/macos-runner`), service, or cluster name
- An AWS account, EKS cluster, or Kubernetes namespace
- A CI pipeline, runner, deployment tool, or build system
- Engineering verbs against known infrastructure: fix, debug,
  investigate, extend, onboard, migrate, deploy, roll out
- A vague task where the user asks "what do we know about X"

Cost is one S3 read. Miss cost is real discovery time and potential
policy violations. When in doubt, fire.

Do **not** fire for tasks that are self-contained ("write a bash script
that sums numbers"), for meta questions about the fact-store itself, or
for tasks the user has already scoped ("read this file and change line
42").

## Step 1 — Query first

The primary interface is the `query` method on the `facts` model. It
assembles a truth packet (facts + constraints) scoped to your task.

```bash
swamp model method run facts query \
  --input scope=<repo-path-or-service-or-account> \
  --input 'hints=["keyword","keyword"]' \
  --input 'kinds=["repository_deploys_to_account","runner_topology"]' \
  --input limit=30 \
  --json --skip-reports > /tmp/fact-store-query.json
```

Guidance on each input:

- `scope`: as narrow as you can honestly make it. `o11n/macos-runner`
  narrows better than `o11n`. Omit if truly cross-cutting.
- `hints`: task-derived keywords. Include the failure mode if there
  is one (`"expired-token"`, `"iam-auth"`). These widen the result to
  include facts outside `scope` whose `kind` overlaps a hint — this is
  how a fact in a different repo's scope surfaces for you when it's
  actually relevant.
- `kinds`: pre-filter by fact kind when you know what you want. Skip
  when you're exploring.
- `limit`: default is 50. Raise for exhaustive investigations, lower
  for hot paths.

**Save the raw output to a file.** Do not grep, head, or pipe through
python inline. Retrieve, save, act. If the packet is empty, that is
itself a fact — proceed with fresh discovery and plan to hand off to
`propose-facts` at the end.

If you also want the whole active-fact catalog for cross-reference:

```bash
swamp model method run facts list_facts \
  --input limit=500 \
  --json --skip-reports > /tmp/fact-store-all.json
```

### When `query`'s hints aren't enough

`query`'s hint matching is kind-based keyword overlap — cheap, and good
for "is there anything filed under a kind like this." It is not
semantic search: it won't find a fact whose `kind` doesn't share
vocabulary with your hint even if the fact's actual content is exactly
what you need. When you need real relevance ranking — you have a
free-text question, not a kind you already suspect, or `query` came
back thin and you're not sure whether that's because nothing exists or
because your hints didn't line up with how it was phrased — fall back
to hybrid search over the same corpus:

```bash
swamp model method run fact-store-index search \
  --input query="<your actual question, in plain language>" \
  --input limit=20 \
  --json --skip-reports > /tmp/fact-store-search.json
```

This embeds your query and runs FTS5 + vector search (RRF-fused) against
the most recent exported index — real semantic relevance, not keyword
overlap. It requires `export` to have been run recently (mole runs this
after activating facts); if the index looks stale, that's worth noting
in your output the same way you'd note any other drift.

## Step 2 — Read the truth packet

The packet is a `query--<scope>` data resource. Structure:

```
{
  "constraints": [ ... ],
  "facts": [ ... ]
}
```

Read `constraints` first. Constraints are human-curated rules
(via `add_constraint`), not evidence-derived. They trump facts if they
conflict, and violations block the work. Example: "Never store
fact-store data in an account that does not have IAM DB auth enabled."

Then rank the `facts` list by `authorityBasis`. Trust decreases as tier
number increases:

| Basis | Tier | Trust it for |
|---|---|---|
| `live_system_verification` | 0 | Current state at verification timestamp |
| `file_is_the_mechanism` | 1 | How the system actually behaves — the file drives it |
| `file_content_observation` | 2 | What the file says about external state (may have drifted) |
| `human_claim_in_file` | 3a | Author's intent, subject to enforcement questions |
| `human_claim_in_ticket` | 3b | Author's intent, older + less discoverable |
| `agent_inference` | 4 | A hypothesis, not a fact — verify before acting on it |

Full framework and adversarial questions per tier live in
[references/authority-tiers.md](references/authority-tiers.md).

For a Tier 0 or Tier 1 fact, act on the value directly. For Tier 2+,
treat the value as a lead — go verify against the current state before
letting it drive an irreversible action.

## Step 3 — Detect drift

Every fact carries a `createdAt` and (if activated) an `activatedAt`.
For Tier 0 and Tier 2 facts, the world can move under the fact. If
what you see live contradicts what the fact says:

1. **Do not silently work around it.** A silent divergence between
   fact-store and reality poisons every future consumer.
2. **Confirm the drift.** Run the same verification the ferret would
   have run — `aws describe-*`, read the cited file at HEAD, etc.
3. **Bookend to `propose-facts`.** Propose a new fact with the correct
   value and cite the divergence in `evidence`. The mole will activate
   the new fact; the stale one can be `withdraw`n by whoever originally
   proposed it, or flagged for the human.
4. **Note it in the current task's output** so the human sees drift
   was detected and handled.

Common drift patterns:

- `live_system_verification` facts about AWS/Kubernetes/GitLab state
  older than a few days
- `file_content_observation` facts where the cited file has been
  modified since `activatedAt`
- Facts whose `scope` references resources that have been deleted or
  renamed

## Step 4 — Bookend to propose-facts

At the end of a task, if the work produced new operational truth
(a runner topology now confirmed, a deployment target discovered, a
constraint the human declared), propose it. This is the loop:

```
consult-facts  →  do work  →  propose-facts
      ↑                                ↓
      └────  next agent benefits  ────┘
```

Hand off to the `propose-facts` skill for the mechanics. The
`authorityBasis` for facts you learned by verification during the task
will typically be `live_system_verification` (Tier 0) or
`file_is_the_mechanism` (Tier 1) — treat that as evidence-strength
opportunity, not just cleanup work.

## Query recipes

Common shapes:

**Fixing a broken thing in a specific repo:**
```bash
swamp model method run facts query \
  --input scope=<group/repo> \
  --input 'hints=["<failure-mode>","<component>"]' \
  --input limit=30 --json --skip-reports > /tmp/query.json
```

**Onboarding to a service:**
```bash
swamp model method run facts query \
  --input scope=<service-or-repo> \
  --input 'hints=["deployment","runtime","dependencies","topology"]' \
  --input limit=50 --json --skip-reports > /tmp/query.json
```

**Cross-account / cross-cluster investigation:**
```bash
swamp model method run facts query \
  --input 'hints=["<account-id-or-cluster-name>"]' \
  --input 'kinds=["repository_deploys_to_account","eks_cluster_hosts_namespace"]' \
  --input limit=50 --json --skip-reports > /tmp/query.json
```

**Existing knowledge about a class of thing (e.g. all runner topologies):**
```bash
swamp model method run facts list_facts \
  --input kind=<kind> \
  --input limit=100 --json --skip-reports > /tmp/kind.json
```

**Free-text question, no known kind or scope:**
```bash
swamp model method run fact-store-index search \
  --input query="<plain-language question>" \
  --input limit=20 --json --skip-reports > /tmp/search.json
```

## Operating loop

1. Task lands. Extract scope + hints from the task description.
2. Query the fact-store, save to file.
3. Read constraints. If any apply and block the task, escalate to the
   human before doing anything.
4. Read facts, ranked by tier. Note which are actionable directly (0-1)
   and which are leads (2-4).
5. If the query came back thin and you're not confident that means
   "nothing exists" rather than "my hints didn't match," fall back to
   `fact-store-index search` before concluding there's nothing there.
6. Do the work, treating the truth packet as a shortcut, not a
   substitute for verification on irreversible actions.
7. On drift: verify, propose the correction, note it in output.
8. On task completion: if new operational truth was produced, hand off
   to `propose-facts`.

## Anti-patterns to avoid

- **Filtering the query output inline** with grep/head/python one-liners.
  Save the raw JSON to a file, then read. This is the same anti-pattern
  the other skills warn about.
- **Trusting Tier 4 (agent_inference) facts without verification.** They
  are hypotheses, not facts. If a Tier 4 fact would drive an
  irreversible action, verify first or downgrade the action.
- **Ignoring drift because "the task doesn't require fixing it."** Drift
  compounds. Propose the correction; it's cheap.
- **Skipping the query because you already know the repo.** You may
  know the repo, but the fact-store may know something you don't (a
  recent activation, a newly-added constraint). Query anyway.
- **Passing a scope you're not sure about.** If unsure, omit `scope`
  and rely on `hints`. Over-scoping filters out relevant facts silently.
- **Concluding "nothing exists" from a thin `query` result** without
  trying `fact-store-index search` first. Kind-based hints and semantic
  search fail differently — a genuine gap should survive both, not just one.
