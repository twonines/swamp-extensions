# @twonines/fact-store

Stores, validates, and serves organizational facts for AI agent consumption.
Implements a propose→review→activate lifecycle with adversarial validation.

## Core Concepts

- **Facts** — accepted relational truths (e.g., "repo X deploys to account Y")
- **Proposals** — candidate facts awaiting adversarial review
- **Constraints** — human-curated behavioral rules that govern agent actions
- **Truth Packets** — assembled context bundles for agent consumption

## Usage

```bash
# Create model
swamp model create @twonines/fact-store facts

# Propose a fact (ferret agent)
swamp model method run facts propose \
  --input kind=repository_deploys_to_account \
  --input 'subjectRef={"refType":"repository","identityKind":"gitlab_path","identityValue":"appsvc/mesh-gateway"}' \
  --input 'value="210266747510"' \
  --input authorityBasis=file_content_observation \
  --input proposedBy=ferret

# List pending proposals (mole agent)
swamp model method run facts list_proposals --input status=proposed

# Activate a proposal (mole agent)
swamp model method run facts activate \
  --input proposalId=<uuid> \
  --input reviewedBy=mole

# Reject a proposal with feedback (mole agent)
swamp model method run facts reject \
  --input proposalId=<uuid> \
  --input reason="Account ID not found in CI config — checked .gitlab-ci.yml" \
  --input reviewedBy=mole

# Query facts before acting (any consuming agent)
swamp model method run facts query \
  --input scope=appsvc/mesh-gateway \
  --input 'hints=["kubernetes","health check"]'

# Add a constraint (human)
swamp model method run facts add_constraint \
  --input kind=required_execution_path \
  --input rule="All Terraform changes require plan output in MR comments" \
  --input 'appliesTo=["terraform"]'
```

## Methods

### Proposal Lifecycle

| Method | Called by | Description |
|--------|-----------|-------------|
| `propose` | Ferret (discovery agent) | Submit a candidate fact |
| `activate` | Mole (reviewer agent) | Promote proposal to active fact |
| `reject` | Mole (reviewer agent) | Reject with actionable feedback |
| `withdraw` | Ferret | Retract a proposal |

### Query & List

| Method | Called by | Description |
|--------|-----------|-------------|
| `query` | Any consuming agent | Assemble a truth packet for a scope/task |
| `list_proposals` | Mole / Ferret | List proposals by status |
| `list_facts` | Any agent | List active facts with filters |

### Administration

| Method | Called by | Description |
|--------|-----------|-------------|
| `add_constraint` | Humans | Add a behavioral rule |

## Authority Tiers

Every fact carries an `authorityBasis` enum value indicating evidence
strength. The full framework — tier definitions, principles, and
adversarial review questions — lives in
[AUTHORITY_TIERS.md](AUTHORITY_TIERS.md).

Valid bases (lowest tier number = strongest evidence):

- `live_system_verification` (Tier 0)
- `file_is_the_mechanism` (Tier 1)
- `file_content_observation` (Tier 2)
- `human_claim_in_file` / `human_claim_in_ticket` (Tier 3)
- `agent_inference` (Tier 4)

Higher-tier sources override lower-tier sources for the same claim.

## Agent Integration

### Ferret (proposer)

Reads scan data from `@twonines/gitlab-repo-scanner`, reasons about
relationships, and proposes facts. Has `propose` and `withdraw` access.
Cannot activate.

### Mole (reviewer)

Reviews pending proposals independently. Has `activate` and `reject`
access. Cannot propose. Default stance: skepticism.

### Consuming Agents (code-gen, reviewers, etc.)

Call `query` before acting to get relevant constraints and facts
injected as context. Read-only access to facts.

## CEL Query Examples

```bash
# All facts about a specific repo
swamp data query 'tags.identityValue == "appsvc/mesh-gateway" && tags.status == "active"'

# All pending proposals
swamp data query 'tags.status == "proposed"'

# All deployment-related facts
swamp data query 'tags.kind.contains("deploys") && tags.status == "active"'
```

## Datastore Recommendations

For production with thousands of facts:
- **Postgres** (`@webframp/postgres-datastore`) — best query performance
- **Turso** (`@zocc/turso`) — good edge performance, SQL-backed

For development:
- **Local** (default) or **S3** (`@swamp/s3-datastore`) — works fine under 1k facts
