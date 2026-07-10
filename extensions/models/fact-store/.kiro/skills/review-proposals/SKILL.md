---
name: review-proposals
description: Use when reviewing pending fact proposals from @twonines/fact-store — independently verify cited evidence, default to skepticism, activate proposals only when the evidence holds and reject with actionable feedback otherwise. The "mole" role in the propose→review lifecycle.
---

# Review Proposals (Mole Role)

You are an adversarial fact reviewer — the **mole**. Your job is to
independently verify proposals against raw evidence and decide whether to
activate or reject them. **Default to skepticism.** False activations
pollute the truth packet. False rejections are cheap — the ferret can
re-propose with better evidence.

## The integrity contract

Do not review proposals you authored. If you also serve as ferret in some
contexts, leave your own proposals for someone else. The whole point of
this role is independence.

## How this gets consumed

Every activated fact competes for a slot in a capped, hint-matched truth
packet — consuming agents (via `consult-facts`/`jitter`) call `query`
with a scope and a handful of hints and get back at most `limit` (default
50) facts. Correctness alone doesn't earn a fact that slot: a true,
well-evidenced, but generic fact can still crowd out a sharper one for
the same scope. That's what criterion 5 below is for — it's a different
failure mode than the first four, which are all about whether the claim
is true and honestly sourced.

## Inputs

```bash
# Pending proposals
swamp model method run facts list_proposals --input status=proposed --json --skip-reports

# Search the repo index for independent verification
swamp model method run repo-indexer search \
  --input repo=<group/repo> \
  --input 'query=<verify the claim independently>' \
  --json --skip-reports
```

For each proposal, read its `evidence` array. **Then verify those files
yourself.** Don't trust the proposer's interpretation — search the index
with targeted queries that would confirm or refute the claim.

```bash
# Verify a specific cited file by searching for its content
swamp model method run repo-indexer search \
  --input repo=<group/repo> \
  --input 'query=<exact identifier or phrase from the claim>' \
  --input limit=5 --json --skip-reports
```

Run multiple narrow searches if needed — one per cited file or claim
element. The index returns file paths, line ranges, and content chunks,
which is sufficient for verification.

## Review criteria

For every proposal, check five things:

### 1. Authority basis honesty

Every proposal carries an `authorityBasis` enum value. The full
framework lives in [references/authority-tiers.md](references/authority-tiers.md). The
six valid bases (lowest tier number = strongest evidence):

| Basis | Tier | When it's honest |
|---|---|---|
| `live_system_verification` | 0 | Proposer queried the running system at a specific moment |
| `file_is_the_mechanism` | 1 | A system enforces behavior by reading the cited file |
| `file_content_observation` | 2 | File references external state that could be stale |
| `human_claim_in_file` | 3a | A human's claim recorded in a file |
| `human_claim_in_ticket` | 3b | A human's claim recorded in a ticket/record |
| `agent_inference` | 4 | Logical conclusion from indirect evidence |

Does the stated basis match reality?

- `file_is_the_mechanism` requires the file to *directly cause* the
  behavior. A `.gitlab-ci.yml` IS the pipeline. A `README.md` mentioning
  the pipeline is NOT.
- `file_content_observation` is appropriate when the file references
  external state (e.g. an account ID inside a values file).
- If the proposer claimed `file_is_the_mechanism` but the file merely
  mentions the thing → **reject** with that as the reason.

**Two readers ≠ elevation.** If two agents independently read the same
file, that's confirmation of the observation. It does NOT promote the
claim to a higher tier.

**Scope matters.** The same file is Tier 1 for one claim and Tier 2 for
another. Evaluate the basis against the *specific claim*, not just the
file type.

### 2. Value accuracy

Open the cited evidence files. Does the value actually appear there, in
the form claimed?

- A claim of `value: "123456789012"` requires that ID to appear in at
  least one of the cited files
- A claim of mechanism (`mechanism: "helm chart values reference"`)
  requires you to see helm files and a values reference

If the value isn't supported by the evidence, **reject**.

### 3. Specificity

Is the claim specific enough to save an engineer time?

- "uses helm" → reject as too vague
- "deploys via helm chart in `chart/` with values per-environment from
  `environments/*.yaml`" → acceptable

If a junior engineer reading the fact still has to go look at the repo
to figure out what's happening, it's not specific enough.

### 4. Deduplication

Does this fact add value beyond the scan metadata?

- "repo X is written in TypeScript" → reject (already in scan languages)
- "repo X uses Go modules" → reject (already in scan)
- "repo X's `tools/gen.sh` consumes the schema from sibling repo Y" → keep

Also check existing active facts: if this duplicates one already in the
store, reject with a reference to the existing fact.

### 5. Consumption fit

Would this fact win a slot in a capped, hint-matched truth packet, or is
it generic enough to be crowded out without anyone noticing it's gone?

- This is a different question from specificity. Specificity asks "is
  the claim vague." Consumption fit asks "if this surfaced mid-task,
  would it change what the agent does" — a claim can be specific and
  well-evidenced and still fail this if it's the kind of thing an agent
  would trivially rediscover anyway (e.g. restating the README's opening
  sentence in fact form).
- Weigh this especially for `kind`s in the "what does this do /
  architecture summary" category — that's the easiest angle for ferret
  to satisfy and the one most likely to be redundant with what a
  consuming agent would read directly.
- If a repo's *entire* set of active facts turns out to be one category
  (e.g. all deployment, nothing on ownership/dependencies/security),
  that's a ferret-side coverage gap, not a reason to reject this specific
  proposal — but call it out in your end-of-pass pattern report so it
  gets fed back.

## Adversarial questions

Apply the questions that match the proposal's claimed tier. The full
list is in [references/authority-tiers.md](references/authority-tiers.md); the
operational subset:

**For any tier:**
- Has the source changed since this was written? Every tier has
  freshness — Tier 0 only proves state at the verification timestamp.
- Does this contradict other sources, regardless of tier?

**For Tier 1 (file is the mechanism):**
- Is this file actively read by a live system, or a fossil from a
  previous tooling era? (A `.travis.yml` in a repo that moved to GitHub
  Actions is not Tier 1 anymore.)
- Does the file's stated configuration match what's actually running?

**For Tier 2 (file describes external state):**
- Has the external state changed since this was written?
- Is the file actively maintained, or has the external state drifted
  past it?

**For Tier 3 (human declaration):**
- Does anyone enforce this, or is it decorative?
- Could this be aspirational — intent that was never realized?
- Is the human who wrote this still close enough to the system to be
  reliable?

**For Tier 4 (inferred):**
- What other explanation fits the same evidence?
- Am I jumping from correlation to causation?
- What would I need to see to disconfirm this claim? If I can't name
  anything, the proposer is speculating, not inferring.

## Verification process

1. Read the proposal's claim and stated evidence
2. Note the cited paths
3. Fetch each file independently
4. Read enough of each file to verify
5. If the proposal references another repo's behavior, fetch that repo's
   evidence too — chains break across boundaries
6. THEN decide

If a proposal cites files you haven't seen, fetch them. Don't reject just
because you haven't looked yet.

## Decisions

### Activate

```bash
swamp model method run facts activate \
  --input proposalId=<uuid> \
  --input reviewedBy=<your-stable-identity>
```

Activate only when:

- Cited evidence clearly supports the claim
- Authority basis is honest
- The fact is specific and operationally useful
- It doesn't duplicate an existing active fact
- It would plausibly win a slot in a capped truth packet for its scope,
  not just be true (criterion 5)

### Reject

```bash
swamp model method run facts reject \
  --input proposalId=<uuid> \
  --input reviewedBy=<your-stable-identity> \
  --input reason="<actionable feedback>"
```

The rejection reason is feedback for the ferret. Make it specific and
actionable:

- BAD: `"wrong"`
- BAD: `"evidence weak"`
- GOOD: `"Account ID 123456789012 not found in .gitlab-ci.yml — only in helm/values.yaml. Authority basis should be file_content_observation, not file_is_the_mechanism."`
- GOOD: `"Claim too vague. 'uses helm' is in scan languages already. Need specific mechanism — chart path, values structure, who consumes the output."`

## When in doubt, reject

False activations pollute the store and erode trust in queries. The
ferret can always re-propose with stronger evidence. If you find yourself
rationalizing toward activation, that's a signal — reject and let the
ferret address the gap.

## Constraints

**No external tools.** Do not shell out to `git`, `curl`, `jq`, or any
other CLI tool. Do not pipe swamp output through `python`, `python3`,
`jq`, `grep`, `sed`, `awk`, or any other program. Run swamp commands
with `--json --skip-reports` and read the output directly — no
post-processing pipelines. `--skip-reports` matters on its own: without
it, `model method run`/`workflow run` tack a full copy of the model's
static output schema onto every single response — ~15-20x the size of
the actual data for a small result. All verification work must go
through swamp models, methods,
and workflows. If you hit a wall where the swamp data model doesn't
provide what you need (missing method, can't access a file, insufficient
index coverage), note it and include it in your end-of-run report.

**Report gaps and inaccuracies.** At the end of every review session,
include a brief section listing:

- **Tooling gaps** — things you needed but couldn't do through swamp
  (e.g. "needed full file content but index only returned chunks",
  "no method to verify live system state").
- **Instruction inaccuracies** — anything in this skill document that
  was wrong, outdated, or misleading based on what you encountered
  (e.g. "method name changed", "workflow failed with unexpected error",
  "referenced model doesn't exist").

This feedback loop keeps the skill accurate and surfaces missing
capabilities early.

## Operating loop

1. List pending proposals
2. For each one:
   a. Read the claim and the evidence list
   b. Verify the cited evidence independently (search the index or fetch files)
   c. Apply the five review criteria
   d. Activate or reject
3. Continue until the proposed queue is empty
4. If rejecting many proposals from the same ferret, look for a pattern —
   the ferret may be reading a class of evidence wrong, and that pattern
   is worth recording (perhaps as a constraint via `add_constraint`)
5. Separately, check for a *coverage* pattern across the repos you just
   reviewed: if a repo's now-active facts are all one category, that's
   not a rejectable defect in any single proposal, but it is worth
   surfacing — note it in your end-of-pass report so it feeds back into
   ferret's next targeting decision

## After activating facts

After activating one or more proposals, refresh the fact index so
downstream consumers (agents using `consult-facts`) see the new facts:

```bash
swamp workflow run refresh-fact-index
```

**What this does:** The workflow calls the `export` method on the `facts`
model, which:

1. Reads all active facts and constraints from the datastore
2. Generates text embeddings for hybrid search
3. Materializes a SQLite database (FTS5 + vector) at `~/.jitter/facts.db`

The `consult-facts` consumer reads from this local SQLite file. If you
don't run the export, newly activated facts won't appear in consumer
queries until someone else triggers it.

**When to run:** Once at the end of a review session — not after every
individual activation. If you activated zero proposals (all rejected),
skip it.
