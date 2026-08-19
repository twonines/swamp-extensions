# swamp-extensions

Source of truth for the **`@twonines`** collective's [Swamp](https://swamp-club.com)
extensions. Every subdirectory here is one publishable extension — its manifest, its
TypeScript, its tests and its own README. The swamp registry serves the published
releases; this repository is where the source those releases were built from lives, and
where changes to them are reviewed.

This repository is **plain git** — no `swamp repo init`, no `.swamp.yaml`. Publishing is a
swamp-repo operation, so it runs from a Swamp-initialized repository elsewhere and points
back at a manifest here. See [Recommended workflow](#recommended-workflow).

## What's here

| Extension | Kind | Source |
| --- | --- | --- |
| `@twonines/coder-audit-collector` | model | [`extensions/models/coder-audit-collector/`](extensions/models/coder-audit-collector) |
| `@twonines/coder-event-log` | model | [`extensions/models/coder-event-log/`](extensions/models/coder-event-log) |
| `@twonines/coder-health-probe` | model | [`extensions/models/coder-health-probe/`](extensions/models/coder-health-probe) |
| `@twonines/coder-metrics-sampler` | model | [`extensions/models/coder-metrics-sampler/`](extensions/models/coder-metrics-sampler) |
| `@twonines/coder-workspace-watch` | model | [`extensions/models/coder-workspace-watch/`](extensions/models/coder-workspace-watch) |
| `@twonines/doc-fact-checker` | model | [`extensions/models/doc-fact-checker/`](extensions/models/doc-fact-checker) |
| `@twonines/fact-store` | model | [`extensions/models/fact-store/`](extensions/models/fact-store) |
| `@twonines/fact-store-aurora-bootstrap` | model | [`extensions/models/fact-store-aurora-bootstrap/`](extensions/models/fact-store-aurora-bootstrap) |
| `@twonines/git-workspace` | model | [`extensions/models/git-workspace/`](extensions/models/git-workspace) |
| `@twonines/k8s-fleet` | model | [`extensions/models/k8s-fleet/`](extensions/models/k8s-fleet) |
| `@twonines/repo-indexer` | model | [`extensions/models/repo-indexer/`](extensions/models/repo-indexer) |
| `@twonines/web-crawl` | model | [`extensions/models/web-crawl/`](extensions/models/web-crawl) |
| `@twonines/index-repos` | workflow | [`workflows/index-repos/`](workflows/index-repos) |
| `@twonines/redmine-story-status` | workflow | [`workflows/redmine-story-status/`](workflows/redmine-story-status) |

Each extension's own README documents what it does, how to install it and what it needs at
runtime. Start there; this file is only about the repository.

## Layout

```
swamp-extensions/                     # plain git — not a swamp repo
├── deno.json                         # SHARED import map — see Conventions
├── deno.lock                         # shared
├── LICENSE                           # MIT, repository-wide
├── blog/                             # write-ups about the extensions
├── extensions/models/
│   ├── _lib/                         # helpers shared across several extensions
│   ├── upstream_extensions.json      # lockfile pinning pulled upstream extensions
│   └── <extension>/
│       ├── manifest.yaml             # paths: {base: manifest}
│       ├── mod.ts                    # + mod_test.ts alongside
│       └── README.md, LICENSE.md     # shipped via additionalFiles
└── workflows/<extension>/
    ├── manifest.yaml
    ├── workflow.yaml
    └── README.md, LICENSE.md
```

The directory is chosen by the extension's **primary** kind: a model extension lives under
`extensions/models/<name>/`, a workflow under `workflows/<name>/` — even when it also ships
models and a report, as `redmine-story-status` does. Prefer flat files inside an extension
directory; subdirectories work (`models: [sub/foo.ts]`) but the published archive mirrors
the path verbatim.

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

**1. Branch and change.** One extension per branch and per PR.

```bash
git switch -c short-description-of-change
```

**2. Test and typecheck what you touched.**

```bash
deno test --allow-env $EXT      # permissions vary per extension, see below
deno check $EXT
```

`--allow-env` is the practical minimum: `@smithy/core` reads an env var at module load, so
without it an AWS-backed test file fails on *import* and the run reports a misleading
failure count. Extensions that touch the filesystem or spawn processes need more.

**3. Bump the version and check the manifest.** Versions are CalVer, `YYYY.MM.DD.N`; ask
the registry what comes next rather than guessing, and keep the version in the manifest and
in the model source in step.

```bash
swamp extension version --manifest $EXT/manifest.yaml --json
swamp extension fmt     $EXT/manifest.yaml --check --repo-dir $REPO --json
swamp extension quality $EXT/manifest.yaml --repo-dir $REPO --json
```

`quality` should report `allPassed: true` with 12 of 12 client-earnable points; the
remaining 2 (`repository-verified`) stay `provisional` until the registry confirms them on
publish.

**4. Open a pull request** and get it merged. This is the review gate — every extension
change reaches `main` by PR.

**5. Publish, only after the merge.** `swamp extension push` must run with `--repo-dir`
pointing at a swamp repository; swamp refuses outright otherwise
(`Not a swamp repository: …`). Nothing else changes, because `paths: {base: manifest}`
makes every path resolve from the manifest's own directory.

```bash
swamp extension push $EXT/manifest.yaml --dry-run --repo-dir $REPO --json
swamp extension push $EXT/manifest.yaml --yes     --repo-dir $REPO --json
```

**6. Consumers adopt it** on their own schedule — a published version is pinned by their
lockfile until they ask for the new one.

```bash
swamp extension pull @twonines/<extension>
```

A yank marks a published version unavailable; it does not delete the archive and it does
not touch git history. Getting a release right before publishing is cheaper than
withdrawing it.

## Conventions

| Rule | Why |
| --- | --- |
| Every manifest sets `paths: {base: manifest}` | Typed keys **and** `additionalFiles` then resolve from the manifest's own directory, so entries stay bare (`models: [mod.ts]`) and the `--repo-dir` repo's typed directories are never consulted. Without it, swamp looks for the source inside the swamp repo and fails |
| **Do not edit the root `deno.json` or `deno.lock`** | They are shared by every extension here. Use fully-inline pinned specifiers instead (`npm:zod@4.4.3`) with `// deno-lint-ignore-file no-import-prefix`, as `repo-indexer/mod.ts` does — self-sufficient, no contention on a shared file, better hermeticity score |
| Leave `extensions/models/_lib/` and other maintainers' directories alone | Shared and cross-extension; a change there is not scoped to your extension |
| `repository:` points at this repository | It is what `repository-verified` checks. Manifests not yet republished since the collective moved here from Codeberg in August 2026 still carry the old URL; new and updated ones use `https://github.com/twonines/swamp-extensions` |
| Ship `README.md` and a license via `additionalFiles` | 4 of the 14 quality points are the README (present, substantive, has a code example); 1 more is the declared license |
| **Never ship a deployment-specific value** | Hostnames, tenant or channel IDs, account numbers, project names and real record IDs belong on the model instance — not in the extension, not as a schema default, not in test fixtures. Removing one later needs a republish *and* a yank, and still leaves it in git history |

Sweep an extension directory before opening the PR. Everything surviving should be
`example.com`, a public service host, or an identifier that is genuinely the extension's
own:

```bash
grep -rhoE "https?://[a-zA-Z0-9._%-]+|[a-z0-9-]+\.(org|com|net|io|local)\b" $EXT | sort -u
grep -rhoE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}" $EXT | grep -v "npm:\|jsr:" | sort -u
grep -rhoE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9]{7,}\b" $EXT | sort -u
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

## Gotchas that cost a debugging cycle

- **A method name the base type already defines silently drops the whole file** — not just
  the colliding method, every method in it, while `swamp doctor extensions` still reports
  `pass` with no loader errors or warnings. Adopting an upstream release that adds methods
  to a type you extend is a reason to run `swamp model type describe <type> --json` and
  confirm your methods are still listed. Filed as [Lab #1734](https://swamp-club.com/lab/1734).
- **`type:` on an `export const extension` is a target, not an identity** — it names the
  existing model type the file adds methods to, so it must match that type exactly and must
  never be renamed to match your extension. Only `export const model` declares a new type.
  An `extension`-shaped file must also list the type it extends in `dependencies:`.
- **Resource names are not a stable contract.** An upstream rename can break a CEL data
  query that `swamp workflow validate` still passes — validation never checks queries
  against runtime resource naming. Pin workflow queries to `workflowRunId == run.id`.
- **`--json` suppresses confirmation prompts** on destructive swamp commands. `--dry-run` is
  the only flag that means "show me first".

## License

MIT — see [`LICENSE`](LICENSE). Extensions ship their own license file alongside their
manifest.
