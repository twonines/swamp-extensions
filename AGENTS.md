# AGENTS

Guidance for anyone — human or agent — changing an extension in this repository. The
workflow itself, from branch to published release, is in [`README.md`](README.md); this
file is the tree, the conventions, and the traps.

## Layout

```
swamp-extensions/                     # plain git — not a swamp repo
├── deno.json                         # SHARED import map — do not edit
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
models and a report, as `redmine-story-status` does.

`mod.ts` / `mod_test.ts` is the usual shape; extensions with several entry points name
files after their role instead (`doc_fact_check.ts`, `doc_review_report.ts`). Prefer flat
files inside an extension directory — subdirectories work (`models: [sub/foo.ts]`), but the
published archive mirrors the path verbatim.

## Conventions

| Rule | Why |
| --- | --- |
| Every manifest sets `paths: {base: manifest}` | Typed keys **and** `additionalFiles` then resolve from the manifest's own directory, so entries stay bare (`models: [mod.ts]`) and the `--repo-dir` repo's typed directories are never consulted. Without it, swamp looks for the source inside the swamp repo and fails |
| **Do not edit the root `deno.json` or `deno.lock`** | Both are shared by every extension here. Import with inline `npm:` specifiers instead — `import { z } from "npm:zod@4"` under `// deno-lint-ignore-file no-import-prefix`, as `repo-indexer/mod.ts` does. They are self-sufficient, create no contention on a shared file, and score better on hermeticity. `@systeminit/swamp-testing` in tests is the one specifier normally taken bare from the import map |
| Leave `extensions/models/_lib/` and other maintainers' directories alone | Shared and cross-extension; a change there is not scoped to your extension |
| `repository:` points at this repository | It is what `repository-verified` checks. Manifests not yet republished since the collective moved here from Codeberg in August 2026 still carry the old URL; new and updated ones use `https://github.com/twonines/swamp-extensions` |
| Ship `README.md` and a license via `additionalFiles` | 5 of the 14 quality points ride on them — 4 for the README (present, substantive, has a code example) and 1 for the declared license |
| Run the tests for the extension you touched, with the flags it needs | `--allow-env` is the practical minimum: `@smithy/core` reads an env var at module load, so without it an AWS-backed test file fails on *import* and the run reports a misleading failure count. Extensions that touch the filesystem or spawn processes need more (`--allow-write`, `--allow-run`). A repo-wide run can surface failures that have nothing to do with your change |
| **Never ship a deployment-specific value** | Hostnames, tenant or channel IDs, account numbers, project names and real record IDs belong on the model instance — not in the extension, not as a schema default, not in test fixtures. Removing one later needs a republish *and* a yank, and still leaves it in git history |

Sweep the extension directory before opening the pull request. Everything surviving should
be `example.com`, a public service host, or an identifier that is genuinely the extension's
own:

```bash
EXT=extensions/models/<name>

grep -rhoE "https?://[a-zA-Z0-9._%-]+|[a-z0-9-]+\.(org|com|net|io|local)\b" $EXT | sort -u
grep -rhoE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}" $EXT | grep -v "npm:\|jsr:" | sort -u
grep -rhoE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9]{7,}\b" $EXT | sort -u
```

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
- **A yank is not a delete.** It marks a published version unavailable; the archive stays,
  and git history is untouched. Getting a release right is cheaper than withdrawing it.
- **`--json` suppresses confirmation prompts** on destructive swamp commands. `--dry-run` is
  the only flag that means "show me first".
