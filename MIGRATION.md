# Migration Plan: Consolidate Fact-Discovery Pipeline

## Current State (post-commit 11e6186)

### Extensions
| Extension | Status | Purpose |
|-----------|--------|---------|
| `@twonines/repo-indexer` | NEW, tested | Clone, chunk, embed, search repos |
| `@twonines/fact-store` | UPDATED | Propose/review/activate facts + `coverage_gaps` |
| `@twonines/fact-store-index` | LEGACY | Exports facts to `~/.jitter/facts.db` |
| `@twonines/gitlab-repo-scanner` | LEGACY | Discover repos, scan (replaced by indexer) |

### Workflows
| Workflow | Status | Purpose |
|----------|--------|---------|
| `@twonines/index-repos` | NEW | Batch index repos via repo-indexer |
| `@twonines/scan-repos` | LEGACY | Batch scan via old scanner |
| `refresh-fact-index` | LOCAL | query → fact-index export |

### Model Instances (in ~/swamp)
| Instance | Type | Status |
|----------|------|--------|
| `repo-indexer` | `@twonines/repo-indexer` | Active |
| `facts` | `@twonines/fact-store` | Active |
| `fact-index` | `@twonines/fact-store-index/exporter` | TO REMOVE |
| `repo-scanner` | `@twonines/gitlab-repo-scanner` | TO REMOVE |

---

## Migration Steps

### Step 1: Merge `fact-store-index` export into `@twonines/fact-store`

**What:** Add an `export` method to `@twonines/fact-store` that reads its own
facts/constraints, embeds them, and writes the jitter SQLite db.

**Why:** Eliminates a separate extension, a separate model instance, the CEL
`data.latest(...)` wiring dance, and the refresh-fact-index workflow's
dependency on a second model.

**Implementation:**
- Port `_lib/impl.ts` logic (flatten, embed, buildSqlite, write) into a new
  `export` method on fact-store
- The method reads facts/constraints from its own data (same pattern as
  `list_facts` and `coverage_gaps`)
- Add embed config as method arguments (not globalArgs — only needed for
  export, not for propose/review):
  - `embedUrl`, `embedToken`, `embedModel`, `embedDim`, `outputPath`
- Or: add embed config to globalArgs since it's used by both `export` and
  potentially `coverage_gaps` in the future
- Use the existing `_lib/sqlite-wasm.ts` shared helper

**Risks:**
- The current exporter gets truth-packet from globalArgs via CEL. The merged
  version reads directly — simpler but different data path. Verify identical
  output.
- The `refresh-fact-index` workflow needs to change from calling `fact-index
  export` to calling `facts export`.

### Step 2: Remove `@twonines/gitlab-repo-scanner` dependency

**What:** The scanner's `discover` method now lives on `repo-indexer`. The
scanner's `scan` and `fetch_files` are replaced by indexer's `index` + `search`.

**Implementation:**
- Delete the `repo-scanner` model instance from `~/swamp/models/`
- Remove `@twonines/gitlab-repo-scanner` from pulled-extensions
- Update `propose-facts` skill (already done — references repo-indexer)
- Update `review-proposals` skill (already done — references repo-indexer)
- Verify no other skills/workflows reference `repo-scanner`

**Risks:**
- Any workflow that references `repo-scanner` will break. Only known one is
  `@twonines/scan-repos` (removed in step 3).

### Step 3: Remove `@twonines/scan-repos` workflow

**What:** Replaced by `@twonines/index-repos`.

**Implementation:**
- Remove from pulled-extensions
- Remove from workflow list (if locally defined)
- The workflow source stays in the extensions repo (don't delete published
  history) but is no longer pulled/used

**Risks:** None — no other automation depends on it.

### Step 4: Rewire `refresh-fact-index` workflow

**What:** Currently runs `facts query` → `fact-index export`. After merge,
it should run `facts query` → `facts export`.

**Implementation:**
- Edit `~/swamp/workflows/workflow-8cce4bd3-...yaml`
- Change the export job from `modelIdOrName: fact-index` to
  `modelIdOrName: facts`, `methodName: export`
- Or: delete the workflow entirely and replace with a single method call
  (since `facts export` can read its own data without needing a prior
  `query` step)

**Risks:**
- If `export` reads facts directly (not from the truth-packet resource),
  the `query` step becomes unnecessary. Simplifies the workflow to a single
  step.

### Step 5: Remove `fact-index` model instance

**What:** No longer needed after merge.

**Implementation:**
- `swamp model delete fact-index` (after verifying no workflows reference it)
- Remove `@twonines/fact-store-index` from pulled-extensions

**Risks:** The model has data artifacts (state snapshots). Deletion is
non-destructive — artifacts remain in the datastore until GC.

---

## Execution Order

1. Merge export into fact-store (code change + test)
2. Rewire refresh-fact-index workflow (or simplify to single step)
3. Runtime test: `facts export` produces identical `~/.jitter/facts.db`
4. Remove `fact-index` model instance
5. Remove `repo-scanner` model instance
6. Remove `@twonines/scan-repos` from pulled-extensions
7. Remove `@twonines/fact-store-index` from pulled-extensions
8. Commit, publish updated `@twonines/fact-store`
9. Publish `@twonines/repo-indexer` and `@twonines/index-repos`

---

## Post-Migration State

### Extensions (2)
- `@twonines/repo-indexer` — index, search, reindex, status, discover
- `@twonines/fact-store` — propose, activate, reject, query, list_facts, list_proposals, add_constraint, coverage_gaps, export

### Workflows (1 published + 1 local)
- `@twonines/index-repos` — batch index repos
- `refresh-fact-index` (local) — single step: `facts export`

### Model Instances (2)
- `repo-indexer`
- `facts`

### Skills (3)
- `propose-facts` (ferret) — searches indexes, proposes facts
- `review-proposals` (mole) — reviews, activates, triggers export
- `consult-facts` — queries the jitter db before engineering work
