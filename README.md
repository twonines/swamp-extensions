# swamp-extensions

Source of truth for the **`@twonines`** collective's [Swamp](https://swamp-club.com)
extensions. One subdirectory per extension — `extensions/models/<name>/` for a model
extension, `workflows/<name>/` for a workflow — each holding its own manifest, TypeScript,
tests and README. For what an extension does and how to install it, read that extension's
README.

The registry serves the published releases; this repository holds the source they were
built from, and is where changes to them are reviewed.

**Plain git — not a Swamp repository.** No `swamp repo init`, no `.swamp.yaml`. Publishing
is a swamp-repo operation, so it runs from a Swamp-initialized repository elsewhere and
points back at a manifest here.

Layout, conventions and traps for working in the tree: [`AGENTS.md`](AGENTS.md).

## Recommended workflow

```
   branch ──▶ pull request ──▶ main ──▶ swamp extension push ──▶ registry
    (here, plain git)                    (from a swamp repo)        │
                                                                    │ pull
                                                                    ▼
                                                              consumers
```

**Push the source first, publish second.** `repository-verified` — 2 of the 14 quality
points — is confirmed server-side against the `repository:` URL in the manifest at publish
time. Publishing before the change is on `main` declares a source location that does not
yet contain the source.

Set two variables for the commands below. The manifest path must be **absolute**: with
`--repo-dir`, a relative manifest path is resolved inside the swamp repo, not here.

```bash
EXT=$PWD/workflows/redmine-story-status      # the extension you are working on
REPO=~/path/to/a/swamp-repo                  # any swamp-initialized repo you own
```

**1. Branch.** One extension per branch and per pull request.

```bash
git switch -c short-description-of-change
```

**2. Test and typecheck what you touched.** Permission flags vary per extension;
`--allow-env` is the minimum — [`AGENTS.md`](AGENTS.md#conventions) explains why.

```bash
deno test --allow-env $EXT
deno check $EXT
```

**3. Bump the version and check the manifest.** Versions are CalVer, `YYYY.MM.DD.N` — ask
the registry what comes next rather than guessing, and keep the manifest version and the
version in the model source in step.

```bash
swamp extension version --manifest $EXT/manifest.yaml --json
swamp extension fmt     $EXT/manifest.yaml --check --repo-dir $REPO --json
swamp extension quality $EXT/manifest.yaml --repo-dir $REPO --json
```

**Aim for 14/14 on `quality`.** Locally you can earn 12 of them, and all 12 should be
earned — `allPassed: true`, `percentage: 100`. The last 2 are `repository-verified`, which
only the registry can award, on publish, from the source that is already on `main`.

**4. Open a pull request** and get it merged. This is the review gate — every extension
change reaches `main` by PR.

**5. Publish, only after the merge.** `--repo-dir` must point at a swamp repository; swamp
refuses outright otherwise (`Not a swamp repository: …`). Nothing else about the command
changes per extension, because `paths: {base: manifest}` makes every path resolve from the
manifest's own directory.

```bash
swamp extension push $EXT/manifest.yaml --dry-run --repo-dir $REPO --json
swamp extension push $EXT/manifest.yaml --yes     --repo-dir $REPO --json
```

**6. Consumers adopt it** on their own schedule — a published version stays pinned by their
lockfile until they ask for the new one.

```bash
swamp extension pull @twonines/<extension>
```

## Working against an unpublished change

A consumer repo can run this working tree directly, without publishing, by registering it
as a source. Load order is local `extensions/` → registered sources → pulled extensions, so
**a registered source shadows a pulled extension of the same type**: the consumer silently
runs uncommitted code while `swamp extension list` still reports the published version.

| Mode | `.swamp-sources.yaml` in the consumer repo | What it runs |
| --- | --- | --- |
| dev | source registered | this working tree, no publish needed |
| consume | no entry | the pulled published version, pinned by the lockfile |

The loop is `source add` → edit and run → publish → `source rm` → `pull`. **Steady state is
zero registered sources.** `.swamp-sources.yaml` is developer-specific and git-ignored.

## License

MIT — see [`LICENSE`](LICENSE). Extensions ship their own license file alongside their
manifest.
