# @twonines/repo-correlator

Stores and manages repository fact proposals with full evidence tracking.
Designed for a two-agent pipeline:

- **Ferret** (proposer): reads scan output, infers relational facts, calls `propose`
- **Mole** (validator): reviews proposals, verifies claims, calls `accept` or `reject`

Accepted facts form the input layer for downstream consumers (e.g. jitter).

## Lifecycle

```
propose → [proposed] → accept → [accepted]
                      → reject → [rejected]
```

Each proposal has a deterministic ID based on `kind + subject + value`, so
re-proposing the same fact is a no-op.

## Usage

```bash
# Create correlator instance
swamp model create @twonines/repo-correlator my-correlator

# Ferret: propose a fact
swamp model method run my-correlator propose \
  --input kind=primary_language \
  --input subject=myorg/my-service \
  --input value=go \
  --input '{"evidence": [{"source": "go.mod", "path": "go.mod"}]}' \
  --input confidence=0.95 \
  --input proposedBy=ferret

# List pending proposals
swamp model method run my-correlator list --input status=proposed

# Mole: accept with additional evidence
swamp model method run my-correlator accept \
  --input id=<proposal-id> \
  --input reviewedBy=mole \
  --input '{"additionalEvidence": [{"source": "ci-vars", "path": ".gitlab-ci.yml"}]}'

# Mole: reject with reason
swamp model method run my-correlator reject \
  --input id=<proposal-id> \
  --input reason="CI config references staging, not the claimed cluster" \
  --input reviewedBy=mole
```

## Methods

### `propose`

Record a new fact proposal. If a proposal with the same `kind + subject + value`
already exists, the call is a no-op.

| Argument      | Type     | Description                                      |
| ------------- | -------- | ------------------------------------------------ |
| `kind`        | string   | Fact kind (e.g. `primary_language`, `deploys_to`) |
| `subject`     | string   | Subject identifier (e.g. `myorg/my-service`)     |
| `value`       | any      | The proposed fact value                          |
| `evidence`    | object[] | Sources examined (`source`, `path?`, `excerpt?`) |
| `confidence`  | number   | 0–1, proposer confidence (default 0.7)           |
| `proposedBy`  | string   | Agent name (default `ferret`)                    |

### `accept`

Accept a proposal as a validated fact. Optionally add evidence mole checked.

| Argument             | Type     | Description                          |
| -------------------- | -------- | ------------------------------------ |
| `id`                 | string   | Proposal ID                          |
| `reviewedBy`         | string   | Validator name (default `mole`)      |
| `additionalEvidence` | object[] | Extra sources mole checked           |

### `reject`

Reject a proposal with a reason.

| Argument     | Type   | Description                      |
| ------------ | ------ | -------------------------------- |
| `id`         | string | Proposal ID                      |
| `reason`     | string | Why the proposal was rejected    |
| `reviewedBy` | string | Validator name (default `mole`)  |

### `list`

List proposals, optionally filtered by status and/or subject prefix.

| Argument  | Type   | Description                              |
| --------- | ------ | ---------------------------------------- |
| `status`  | string | `proposed`, `accepted`, or `rejected`    |
| `subject` | string | Subject prefix filter                    |

## CEL Reference

```
# Get all accepted proposals
data.latest("my-correlator", "list").attributes.value.proposals
```
