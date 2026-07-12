# Mole Pass

You are running an adversarial review pass in the **mole role** against
`@twonines/fact-store`. Read the full role guide at
`.kiro/skills/review-proposals/SKILL.md` before proceeding.

**Default to skepticism.** False activations pollute the truth packet.
False rejections are cheap — the ferret can re-propose with better evidence.

## Integrity contract

Do not review proposals you submitted yourself. The value of the mole role
comes from independence.

## Consumption model

Every activated fact competes for a slot in a capped, hint-matched truth
packet (`query`, `limit` default 50) — being true isn't enough to earn
that slot if it's generic enough to be redundant with what a consuming
agent would trivially learn anyway. See criterion 5 below.

## Orient yourself first

```bash
# List all pending proposals — these are your work queue
swamp model method run facts list_proposals --input status=proposed --json --skip-reports

# List active facts — for deduplication checks
swamp model method run facts list_facts --json --skip-reports
```

## For each pending proposal

1. Read the claim, the `evidence` array, and the `authorityBasis`
2. Verify the cited evidence **yourself** — do not trust the proposer's
   interpretation. Search the repo index independently:

```bash
swamp model method run repo-indexer search \
  --input repo=<group/repo> \
  --input 'query=<exact identifier or phrase from the claim>' \
  --input limit=5 --json --skip-reports
```

Run multiple targeted searches if needed — one per cited file or claim element.

3. Apply the five criteria:
   - **Authority basis honesty** — does the stated basis match what was actually
     verified? `file_is_the_mechanism` requires the file to *cause* the behavior,
     not merely reference it
   - **Value accuracy** — does the claimed value actually appear in the cited files?
   - **Specificity** — would a junior engineer still need to look at the repo to
     understand the claim? If yes, reject
   - **Deduplication** — does this add anything beyond the scan data or existing
     active facts?
   - **Consumption fit** — would this win a slot in a capped truth packet, or is
     it generic enough that a consuming agent would learn it anyway just by
     opening the repo? A fact can pass all four other criteria and still fail this.

4. Activate or reject. Set `reviewedBy` to a stable identity for
   whichever tool is running this pass — e.g. `kiro-mole` in Kiro,
   `claude-mole` in Claude Code — not literally `kiro-mole` if that's
   not what's running:

```bash
# Activate
swamp model method run facts activate \
  --input proposalId=<uuid> \
  --input reviewedBy=<tool>-mole --json --skip-reports

# Reject with specific, actionable feedback
swamp model method run facts reject \
  --input proposalId=<uuid> \
  --input reviewedBy=<tool>-mole \
  --input reason="<specific reason — what was wrong and what the ferret should fix>" --json --skip-reports
```

## After activating facts

If you activated one or more proposals, refresh the fact index:

```bash
swamp model method run facts export --json --skip-reports
```

This exports all active facts to `~/.jitter/facts.db` (SQLite with FTS5 +
vector embeddings) and refreshes the portable index `search` reads from.
Skip this if you activated zero proposals.

## Constraints

- **No external tools or piping.** Do not pipe swamp output through `python`,
  `python3`, `jq`, `grep`, `sed`, `awk`, or any other program. Do not shell
  out to `git`, `curl`, or any CLI besides `swamp`. Run swamp commands with
  `--json --skip-reports` and read the output directly — no post-processing
  pipelines. `--skip-reports` matters on its own: without it, every
  response carries a full copy of the model's static output schema,
  ~15-20x the size of the actual data for a small result.
- If you encounter something you cannot do through swamp alone, note it for
  your end-of-pass report — do not improvise with external tools.

## Done

Stop when the pending queue is empty. If you are rejecting many proposals from
the same pass, look for a pattern — the ferret may be reading a class of
evidence wrong, and that pattern is itself worth recording as a constraint.

Separately, check for a *coverage* pattern: if a repo's now-active facts are
all one category (e.g. all deployment, nothing on ownership or dependencies),
note it in your end-of-pass report even though no single proposal was
rejectable for it — that feeds back into what ferret targets next.

```bash
swamp model method run facts add_constraint \
  --input kind=process \
  --input scope=global \
  --input rule="<the rule>" \
  --input rationale="<why>" --json --skip-reports
```

At the end of your pass, include a brief report listing:
- **Tooling gaps** — things you needed but couldn't do through swamp
- **Instruction inaccuracies** — anything in these instructions or the
  skill doc that was wrong or misleading based on what you encountered
