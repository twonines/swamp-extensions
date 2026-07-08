# Ferret Pass

You are running a fact-discovery pass in the **ferret role** against
`@twonines/fact-store`. Read the full role guide at
`.kiro/skills/propose-facts/SKILL.md` before proceeding.

## Orient yourself first

Run these commands in order before proposing anything:

```bash
# What repos are indexed and available to search
swamp model method run repo-indexer list-indexed --json

# What facts are already active — do not re-propose these
swamp model method run facts list_facts --json

# What proposals are pending — do not double-propose
swamp model method run facts list_proposals --input status=proposed --json

# What was rejected — address the reason before re-proposing, or skip
swamp model method run facts list_proposals --input status=rejected --json
```

## Scope

Discover and search repos via `repo-indexer`. For each repo:

1. Check its index status (`swamp model method run repo-indexer status --input repo=<group/repo> --json`)
2. Search for high-signal content with hypothesis-driven queries:
   ```bash
   swamp model method run repo-indexer search \
     --input repo=<group/repo> \
     --input 'query=<your hypothesis or question>' \
     --input limit=10 --json
   ```
3. Follow reference chains: if a search result mentions an account ID, cluster
   name, or another repo, search for those identifiers to verify before proposing
4. Propose operational facts that would save an engineer real exploration time

Run multiple searches per repo with different angles — CI/CD, infrastructure,
architecture, integrations, ownership, data stores, deployment targets.

## Propose

```bash
swamp model method run facts propose \
  --input kind=<snake_case_relation> \
  --input scope=<repo-path-or-global> \
  --input 'subjectRef={"refType":"repository","identityKind":"gitlab_path","identityValue":"group/repo"}' \
  --input 'value=<json-object-or-string>' \
  --input authorityBasis=<tier> \
  --input proposedBy=kiro-ferret \
  --input 'evidence=["cited/file","another/file"]' --json
```

## Quality bar — check before every propose

- Is the claim specific enough that someone could use it to skip exploration?
- Does `authorityBasis` honestly reflect how I came to know this?
- Does `evidence` point at files that actually support the claim?
- Have I checked for duplicates among active facts?
- Have I checked my rejected proposals and addressed the reason?

## Constraints

- **No external tools or piping.** Do not pipe swamp output through `python`,
  `python3`, `jq`, `grep`, `sed`, `awk`, or any other program. Do not shell
  out to `git`, `curl`, or any CLI besides `swamp`. Run swamp commands with
  `--json` and read the output directly — no post-processing pipelines.
- If you encounter something you cannot do through swamp alone, note it for
  your end-of-pass report — do not improvise with external tools.

## Done

Stop when you've covered the targeted repos. Prefer a few well-evidenced
facts over many weak ones. Do not pad.

At the end of your pass, include a brief report listing:
- **Tooling gaps** — things you needed but couldn't do through swamp
- **Instruction inaccuracies** — anything in these instructions or the
  skill doc that was wrong or misleading based on what you encountered
