# @twonines/fact-store — Design Spec

## Purpose

A swamp extension that stores, validates, and serves organizational facts
for AI agent consumption. Facts are relational truths about infrastructure,
repositories, services, teams, and how they connect — the connective tissue
that no single API reveals.

Built to replace jitter's flat-file store and MCP interface with
swamp-native data, while preserving the core concepts that work: typed
facts, entity resolution, authority tiers, and the ferret/mole validation
workflow.

## Relationship to Existing Work

| Component | Role |
|-----------|------|
| `@twonines/gitlab-repo-scanner` | Harvests raw evidence (scan data) |
| `@twonines/fact-store` (this) | Stores facts, serves truth packets |
| Ferret agent | Reads scan data, proposes facts via `propose` |
| Mole agent | Reviews proposals via `activate` / `reject` |
| Consuming agents | Query facts via `query` before acting |

The scanner produces structured evidence. The fact-store holds curated
knowledge derived from that evidence. Agents bridge the two.

## Data Model

### Facts

An accepted, active truth claim about an entity.

```typescript
const FactSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),           // e.g. "repository_deploys_to_account"
  scope: z.string(),          // "global" or a narrower scope
  subjectRef: z.object({
    refType: z.string(),      // "repository", "aws_account", "k8s_cluster", etc.
    identityKind: z.string(), // "gitlab_path", "account_id", "cluster_name"
    identityValue: z.string(),
  }),
  value: z.unknown(),         // string, boolean, array, or object
  authorityBasis: z.string(), // "file_is_the_mechanism", "file_content_observation", etc.
  status: z.enum(["active", "superseded", "retired"]),
  proposedBy: z.string(),     // agent or human identifier
  activatedBy: z.string().optional(),
  createdAt: z.string(),
  activatedAt: z.string().optional(),
});
```

### Proposals

A candidate fact awaiting adversarial review.

```typescript
const ProposalSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  scope: z.string(),
  subjectRef: SubjectRefSchema,
  value: z.unknown(),
  authorityBasis: z.string(),
  status: z.enum(["proposed", "activated", "rejected", "withdrawn"]),
  proposedBy: z.string(),
  evidence: z.array(z.string()).optional(), // references to scan data or other sources
  rejectionReason: z.string().optional(),
  createdAt: z.string(),
  reviewedAt: z.string().optional(),
  reviewedBy: z.string().optional(),
});
```

### Constraints

Human-curated behavioral rules. Not derived from evidence — authored
directly by people who know how the system should behave.

```typescript
const ConstraintSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["process", "required_execution_path", "naming_convention",
                "security_boundary", "deployment_rule"]),
  scope: z.string(),
  rule: z.string(),           // the constraint text
  rationale: z.string().optional(),
  appliesTo: z.array(z.string()).optional(), // tag-based matching hints
  status: z.enum(["active", "retired"]),
  createdAt: z.string(),
});
```

### Entities

Things that exist independently and can be referenced across facts.
Entities emerge from facts — proposing a fact about a new subject
implicitly creates the entity.

```typescript
const EntitySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),           // "repository", "aws_account", "k8s_cluster", etc.
  canonicalLabel: z.string(), // human-readable name
  identityHints: z.array(z.object({
    kind: z.string(),
    value: z.string(),
  })),
  createdAt: z.string(),
});
```

## Methods

### `propose`

Called by the ferret agent (or any discovery agent) to submit a candidate fact.

**Input:**
```typescript
z.object({
  kind: z.string(),
  scope: z.string().default("global"),
  subjectRef: SubjectRefSchema,
  value: z.unknown(),
  authorityBasis: z.string(),
  proposedBy: z.string(),
  evidence: z.array(z.string()).optional(),
})
```

**Behavior:**
- Creates a proposal record with status `proposed`
- If the subject entity doesn't exist yet, creates it from `subjectRef`
- If an active fact with the same `kind` + `subjectRef` exists and the
  value differs, marks the proposal as a potential update (mole decides)
- Returns the proposal ID

**Output resource:** `proposal` (versioned per instance)

### `activate`

Called by the mole agent to promote a proposal to an active fact.

**Input:**
```typescript
z.object({
  proposalId: z.string().uuid(),
  reviewedBy: z.string(),
})
```

**Behavior:**
- Moves proposal status to `activated`
- Creates (or updates) the corresponding fact with status `active`
- If this supersedes an existing fact (same kind + subject, different value),
  marks the old fact as `superseded`
- Returns the new fact ID

**Output resource:** `fact` (versioned per instance)

### `reject`

Called by the mole agent to reject a proposal with feedback.

**Input:**
```typescript
z.object({
  proposalId: z.string().uuid(),
  reason: z.string(),
  reviewedBy: z.string(),
})
```

**Behavior:**
- Moves proposal status to `rejected`
- Stores the rejection reason for the proposing agent's feedback loop

**Output resource:** `proposal` (updated version)

### `withdraw`

Called by the proposing agent to retract a proposal (e.g., after seeing
rejection feedback and agreeing).

**Input:**
```typescript
z.object({
  proposalId: z.string().uuid(),
})
```

### `query`

The consumption method. Called by any agent that needs contextual facts
before acting.

**Input:**
```typescript
z.object({
  scope: z.string().optional(),     // repo path, service name, etc.
  hints: z.array(z.string()).optional(), // task keywords
  kinds: z.array(z.string()).optional(), // filter to specific fact kinds
  limit: z.number().default(50),
})
```

**Behavior:**
1. Resolve `scope` to entities via identity hint matching
2. Collect active facts where `subjectRef` matches resolved entities
3. If `hints` provided, also include facts with keyword overlap in kind/value
4. Include all active constraints that match scope or hints via `appliesTo`
5. Return assembled truth packet

**Output resource:** `truth-packet` (short-lived, not versioned deeply)

```typescript
const TruthPacketSchema = z.object({
  constraints: z.array(ConstraintSchema),
  facts: z.array(FactSchema),
  entities: z.array(EntitySchema),
  assembledAt: z.string(),
  query: z.object({ scope, hints, kinds }),
});
```

### `add_constraint`

Human-facing method for authoring behavioral rules.

**Input:**
```typescript
z.object({
  kind: z.string(),
  scope: z.string().default("global"),
  rule: z.string(),
  rationale: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
})
```

### `list_proposals`

List proposals filtered by status. Used by mole to find work and by
ferret to check rejection feedback.

**Input:**
```typescript
z.object({
  status: z.enum(["proposed", "rejected", "all"]).default("proposed"),
  limit: z.number().default(50),
})
```

### `list_facts`

List active facts, optionally filtered.

**Input:**
```typescript
z.object({
  scope: z.string().optional(),
  kind: z.string().optional(),
  subjectRef: SubjectRefSchema.optional(),
  limit: z.number().default(100),
})
```

## Workflow: scan-and-enrich

Extends the existing `scan-repos` workflow with fact derivation.

```yaml
name: scan-and-enrich
trigger:
  schedule: "0 4 * * 1"  # Weekly Monday 4am

jobs:
  - name: discover
    steps:
      - name: find-repos
        task:
          type: model_method
          modelIdOrName: repo-scanner
          methodName: discover
          inputs:
            groups: ${{ inputs.groups }}

  - name: scan
    dependsOn: [{ job: discover, condition: { type: succeeded } }]
    steps:
      - name: scan-repo
        forEach:
          item: repo
          in: ${{ data.latest("repo-scanner", "discovery").attributes.repos }}
        task:
          type: model_method
          modelIdOrName: repo-scanner
          methodName: scan
          inputs:
            projectPath: ${{ self.repo.path }}
```

The ferret and mole steps are **not in the workflow**. They are agent
sessions triggered after scan completes — because they involve LLM
reasoning that doesn't belong in a declarative DAG. The workflow produces
the evidence. The agents consume it and interact with the fact-store
methods.

## Agent Interaction Pattern

### Ferret (proposer)

```
1. Read scan data: swamp data get repo-scanner scan --json
2. Reason about relationships, entities, connections
3. Check existing facts: swamp model method run fact-store list_facts --input scope=...
4. Propose new facts: swamp model method run fact-store propose --input '{...}'
5. Repeat for discovered entities
```

Ferret's prompt (FERRET.md equivalent) instructs it to:
- Read scan output as evidence
- Follow entity threads (a reference in one repo points to another entity)
- Propose typed facts with correct authority basis
- Check for rejected proposals and withdraw or re-propose

### Mole (reviewer)

```
1. List pending proposals: swamp model method run fact-store list_proposals --input status=proposed
2. For each proposal:
   a. Read the claim and stated evidence
   b. Independently verify via repo-scanner data or fetch_files
   c. Decide: activate or reject
3. swamp model method run fact-store activate --input '{...}'
   OR
   swamp model method run fact-store reject --input '{reason: "..."}'
```

Mole's prompt (MOLE.md equivalent) instructs it to:
- Default to skepticism
- Independently verify — don't trust ferret's interpretation
- Check authority basis honesty
- Provide actionable rejection reasons

### Consuming Agent (code-gen, reviewer, etc.)

```
1. Before acting: swamp model method run fact-store query \
     --input scope="appsvc/mesh-gateway" \
     --input 'hints=["kubernetes","health check","deployment"]' --json
2. Incorporate returned constraints and facts as hard requirements
3. Proceed with task
```

## Authority Tiers

Evidence strength is classified by a five-tier framework documented in
[AUTHORITY_TIERS.md](AUTHORITY_TIERS.md). The framework is preserved from
jitter and enforced via the `authorityBasis` enum on `Fact` and `Proposal`.

Higher tiers supersede lower when they conflict. Same-tier conflicts
require mole to decide.

## What This Does NOT Include

- **Embeddings / vector search** — start with keyword + entity matching.
  Add semantic search later if precision is insufficient.
- **LLM calls inside the extension** — the extension is I/O and state.
  Agents do the reasoning externally.
- **Scheduled agent runs** — that's an operational concern, not an
  extension concern. Use `swamp serve` webhooks or cron to trigger agents.
- **Migration of existing jitter data** — clean start. Existing facts can
  be re-derived from fresh scans.
- **MCP interface** — consumed via `swamp` CLI only.

## File Structure

```
extensions/models/fact-store/
  mod.ts          # Extension model implementation
  mod_test.ts     # Tests
  manifest.yaml   # Extension metadata
  README.md       # Usage documentation
```

## Storage Strategy

### Scale requirements

- Hundreds to thousands of repositories
- Tens of thousands of facts at maturity
- Multiple agents (across machines) reading/writing concurrently
- `query` method must return in < 200ms regardless of corpus size

### Swamp datastore options

The extension uses swamp's native `writeResource` / `readResource` — the
physical storage depends on which datastore the swamp repo is configured with:

| Backend | Viable? | Notes |
|---------|---------|-------|
| `@webframp/postgres-datastore` | **Best fit** | Indexed queries, shared, AWS-native (Aurora) |
| `@zocc/turso` | Good | Edge SQLite, fast reads, remote-shared |
| `@swamp/s3-datastore` | Baseline | Works but no indexed queries — scan-based |
| `@keeb/mongodb-datastore` | Possible | Document queries, distributed |

**Recommendation:** Design the extension to be datastore-agnostic (it just
writes/reads swamp resources). For production deployment, use postgres or
turso for query performance. S3 works for initial development.

### Resource granularity

**Per-fact resources** with instance names that encode identity:

```
fact-store/fact/{kind}/{identity_kind}/{identity_value}
fact-store/proposal/{proposal_id}
fact-store/entity/{entity_id}
fact-store/constraint/{constraint_id}
```

This gives:
- Individual versioning per fact (see when it changed)
- Tags for filtering (`kind`, `scope`, `subjectRef.refType`)
- CEL-queryable via `swamp data query`

The `query` method uses swamp's data query primitives to filter, then
assembles the truth packet from results. If CEL queries push down to the
datastore (postgres does SQL, turso does SQL), this stays fast at scale.

### Open question: query push-down

Need to verify: does `swamp data query` with a CEL predicate perform
server-side filtering when backed by postgres/turso? Or does it load all
resources then filter client-side? This determines whether per-fact
resources scale or whether we need a batch/index approach.

If push-down works → per-fact resources are fine at 10k+ facts.
If it's client-side → we'll need an internal index (the extension
maintains a lightweight lookup structure alongside swamp resources).

## Open Questions

2. **Entity lifecycle**: Should entities be explicitly managed (create/retire)
   or purely emergent from facts? Jitter had explicit entities with identity
   hints. That was useful for resolution but created orphans. Propose:
   entities emerge from first fact proposed against them, but can be manually
   merged/retired.

3. **Constraint authoring**: CLI-only via `swamp model method run`, or also
   via YAML files in the repo that get loaded on model creation? YAML would
   let constraints be version-controlled with the extension. Leaning toward
   both — YAML as seed, method for runtime additions.

4. **Truth packet caching**: Should `query` produce a short-lived cached
   resource, or compute fresh every time? If agents call it frequently,
   caching matters. If it's once-per-task, fresh is fine.
