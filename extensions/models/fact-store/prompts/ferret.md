# Ferret Pass

You are running a fact-discovery pass in the **ferret role** against
`@twonines/fact-store`. Read the full role guide at
`.kiro/skills/propose-facts/SKILL.md` before proceeding.

## Orient yourself first

Run these commands in order before proposing anything:

```bash
# What repos are indexed and available to search
swamp model method run repo-indexer list-indexed --json --skip-reports

# What facts are already active — do not re-propose these
swamp model method run facts list_facts --json --skip-reports

# What proposals are pending — do not double-propose
swamp model method run facts list_proposals --input status=proposed --json --skip-reports

# What was rejected — address the reason before re-proposing, or skip
swamp model method run facts list_proposals --input status=rejected --json --skip-reports
```

## Consumption model

Facts get injected into a capped, hint-matched truth packet — they
don't get browsed. A repo that only answers "what does this do" is
invisible to a conversation about who owns it or where its secrets live.
See "How this gets consumed" and the priority list in the skill doc
before you start — cross-repo connections, deployment targets, ownership,
and secrets location rank above architecture summaries.

## Scope

Discover and search repos via `repo-indexer`. For each repo:

1. Check its index status (`swamp model method run repo-indexer status --input repo=<group/repo> --json --skip-reports`)
2. Run `coverage_gaps` scoped to this repo and use `single_dimension`'s
   `detail` as a checklist of angles you haven't tried yet
3. Search for high-signal content with hypothesis-driven queries:
   ```bash
   swamp model method run repo-indexer search \
     --input repo=<group/repo> \
     --input 'query=<your hypothesis or question>' \
     --input limit=10 --json --skip-reports
   ```
4. Follow reference chains: if a search result mentions an account ID, cluster
   name, or another repo, search for those identifiers to verify before proposing
5. If anything you find contradicts an existing active fact, propose the
   correction with `supersedesFactId` set to the stale fact's id (see
   Propose below) — don't retire it yourself. Mole retires it
   automatically if it activates your correction; if it rejects your
   proposal instead, the old fact correctly stays active.
6. Propose operational facts that would save an engineer real exploration time

Run multiple searches per repo with different angles — cross-repo
dependencies and deployment targets first, ownership and secrets next,
architecture/CI last. Don't move to the next repo until you've at least
tried the higher-priority angles, even if an easy architecture fact
already landed.

## Propose

Set `proposedBy` to a stable identity for whichever tool is running this
pass — e.g. `kiro-ferret` in Kiro, `claude-ferret` in Claude Code. Not a
placeholder, and not literally `kiro-ferret` if that's not what's running.

```bash
swamp model method run facts propose \
  --input kind=<snake_case_relation> \
  --input scope=<repo-path-or-global> \
  --input 'subjectRef={"refType":"repository","identityKind":"gitlab_path","identityValue":"group/repo"}' \
  --input 'value=<json-object-or-string>' \
  --input authorityBasis=<tier> \
  --input proposedBy=<tool>-ferret \
  --input 'evidence=["cited/file","another/file"]' \
  --input supersedesFactId=<stale-fact-id-if-correcting-one> --json --skip-reports
```

Omit `supersedesFactId` for a normal new fact — only set it when this
proposal corrects a specific existing active fact.

## Quality bar — check before every propose

- Is the claim specific enough that someone could use it to skip exploration?
- Does `authorityBasis` honestly reflect how I came to know this?
- Does `evidence` point at files that actually support the claim?
- Have I checked for duplicates among active facts?
- Have I checked my rejected proposals and addressed the reason?
- Have I set `supersedesFactId` on any proposal that corrects an active fact, rather than just noting the contradiction?

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

Stop when you've attempted the priority angles for every targeted repo —
not when you have one satisfying fact. Attempted-and-found-nothing is
done; never-asked is not. Prefer a few well-evidenced facts over many
weak ones — that's about not padding with redundant claims, not license
to stop at the first easy angle.

At the end of your pass, include a brief report listing:
- **Tooling gaps** — things you needed but couldn't do through swamp
- **Instruction inaccuracies** — anything in these instructions or the
  skill doc that was wrong or misleading based on what you encountered
