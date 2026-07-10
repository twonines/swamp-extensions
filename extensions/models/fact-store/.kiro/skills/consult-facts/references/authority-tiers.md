# Authority Tiers

A framework for classifying evidence strength when storing operational
facts. Agents propose facts about systems (repositories, services,
infrastructure); humans and other agents act on those facts. Without a
shared vocabulary for how strongly the evidence supports each claim, an
inference made from a stale README is indistinguishable from a live API
query. This framework makes evidence basis explicit and challengeable.

A **claim** is a statement that can be true or false — e.g., "repository
X deploys to account Y," "service Z runs on cluster prod-east-1." Every
stored fact represents exactly one claim about exactly one subject.

## Scope matters

The tier depends on the claim, not the file. The same `.gitlab-ci.yml`
is **Tier 1** for the claim "this repo runs CI through GitLab" — the file
mechanically drives the behavior — but **Tier 2** for the claim "this
repo deploys to account 123456789012" — the file references the account
ID, but doesn't create or enforce it.

Always evaluate evidence in light of the specific claim being made.

## Tier 0: Live system verification

Verified against the actual running system at a specific moment.

- AWS API confirms account exists and is ACTIVE
- kubectl confirms cluster is running
- GitLab API confirms user has Maintainer role

**Authority basis**: `live_system_verification`

**Test**: Did I query the running system itself, not a file or record
describing the system? If yes → Tier 0.

## Tier 1: File is the mechanism

A system *enforces* behavior by reading this file. True by construction.

- `go.mod` → Go toolchain uses it; delete it and build breaks
- `.gitlab-ci.yml` → GitLab reads it to run pipelines
- `versions.tf` → Terraform enforces provider constraints

**Authority basis**: `file_is_the_mechanism`

**Test**: Is there a system that reads this file and changes behavior
based on its contents? If yes → Tier 1.

## Tier 2: File describes external state

File references something that exists independently. The reference could
be stale.

- Account IDs in CI variables
- Cluster names in directory structures
- Service names in manifests

**Authority basis**: `file_content_observation`

**Test**: If I delete this file, does the external thing cease to exist?
If no → Tier 2.

## Tier 3: Human declaration

A human stated a claim. The file or record contains the claim but doesn't
enforce it.

- README descriptions
- CODEOWNERS (unless enforced by approval rules)
- Ticket descriptions
- Design doc statements

**Authority basis**: `human_claim_in_file` or `human_claim_in_ticket`

**Test**: If I delete this file or close this ticket, do the behaviors
described change? If no → Tier 3.

The two basis variants distinguish persistence shape: file-based claims
live with the codebase and rot slowly; ticket-based claims are easier to
lose and harder to discover. Use the variant that matches where the
claim actually lives.

## Tier 4: Inferred

Logical conclusion from indirect evidence. No direct observation of the
claim itself.

- "This service depends on Redis because the Dockerfile installs the
  redis client AND environment variables reference a Redis URL"
- "This repo is the upstream for the deployed artifact because the
  artifact name matches and the build pipeline runs here"

**Authority basis**: `agent_inference`

Lowest confidence. Should be flagged for review. Inference becomes
speculation when the evidence chain is one step removed too many — when
you can't name what would disconfirm the claim, you've left inference
behind.

---

## Principles

- A higher-tier source always overrides a lower-tier source for the same
  claim.
- Two agents reading the same file is confirmation of the observation,
  NOT elevation to a higher tier.
- The filename is not the tier. CODEOWNERS doesn't automatically make
  its contents Tier 1. Ask what enforces the claim.
- When you activate a fact, the authority basis should reflect what you
  actually verified — not what would have been ideal to verify.

## Adversarial Questions

Different tiers have different failure modes. Apply the questions that
match the tier of the proposal under review.

### For any tier (decay & contradiction)

- Has the source changed since this was written? Every tier has
  freshness — Tier 0 only proves state at the verification timestamp,
  files can be edited, humans change their minds.
- Does this contradict other sources, regardless of tier?

### For Tier 1 (file is the mechanism)

- Is this file actively read by a live system, or a fossil from a
  previous tooling era? A `.travis.yml` in a repo that moved to GitHub
  Actions is not Tier 1 anymore.
- Does the file's stated configuration match what's actually running?

### For Tier 2 (file describes external state)

- Has the external state changed since this was written?
- Is the file actively maintained, or has the external state drifted
  past it?

### For Tier 3 (human declaration)

- Does anyone enforce this, or is it decorative?
- Could this be aspirational — intent that was never realized?
- Is the human who wrote this still close enough to the system to be
  reliable?

### For Tier 4 (inferred)

- What other explanation fits the same evidence?
- Am I jumping from correlation to causation?
- What would I need to see to disconfirm this claim? If I can't name
  anything, I'm speculating, not inferring.
