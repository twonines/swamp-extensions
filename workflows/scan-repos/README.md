# @twonines/scan-repos

Batch scan of GitLab repositories, orchestrated as a swamp workflow. Given
an explicit list of repo paths, scans each in parallel. Given no list,
first discovers active repos (optionally scoped to specific groups and/or
by last-activity date), then scans each discovered repo. Produces one
versioned `scan` resource per repo — the source-of-truth input to any
downstream fact-discovery agent (typically one loading the
[@twonines/fact-store](https://swamp.club/extension/@twonines/fact-store)
`propose-facts` skill).

## What it produces

For each repo scanned, one `scan` resource is written under the scanner
model instance. The resource includes: project metadata (name,
description, default branch, visibility, star/fork counts, topics), a
languages breakdown, a recursive file tree, and the contents of a fixed
list of high-signal files (Dockerfile, `.gitlab-ci.yml`, `go.mod`,
`package.json`, README, etc.) when present.

## Prerequisites

- `@twonines/gitlab-repo-scanner` pulled (declared dependency — pulled
  automatically). See
  [that extension's README](https://swamp.club/extension/@twonines/gitlab-repo-scanner)
  for the full list of high-signal files and scan-resource schema.
- A model instance of `@twonines/gitlab-repo-scanner` **named
  `repo-scanner`**. The workflow references this specific name.
- The GitLab personal access token vaulted rather than inlined. The
  scanner's `token` global argument is schema-tagged sensitive; passing
  it through `vault.get(...)` keeps it out of shell history, logs, and
  swamp state files.

## One-time setup

```bash
# Pull the extension (auto-pulls the scanner dependency)
swamp extension pull @twonines/scan-repos

# Create a filesystem vault and store the PAT
swamp vault create @swamp/filesystem-vault my-vault \
  --global-arg 'path=vaults/my-vault'
swamp vault set my-vault gitlab-pat <YOUR-PAT>

# Create the scanner instance the workflow references
swamp model create @twonines/gitlab-repo-scanner repo-scanner \
  --global-arg 'url=https://gitlab.com' \
  --global-arg 'token=${{ vault.get("my-vault", "gitlab-pat") }}'
```

## Running

Two usage patterns.

**Explicit repo list** — bypass discovery, scan exactly what you name:

```bash
swamp workflow run '@twonines/scan-repos' \
  --input 'repos=["myorg/service-a", "myorg/service-b", "otherorg/lib-c"]'
```

**Discovery-driven** — scan every active repo in one or more groups:

```bash
swamp workflow run '@twonines/scan-repos' \
  --input 'groups=["engineering", "platform"]' \
  --input 'activeSince=2026-04-01'
```

If both `repos` and `groups`/`activeSince` are provided, the explicit
`repos` list wins and the discovery job is skipped entirely.

## Inspecting results

After the workflow completes, each per-repo scan is queryable by that
repo's projectPath (`/` replaced by `--`):

```bash
swamp data get repo-scanner scan --tag 'projectPath=myorg--service-a' --json
```

Or list every scan resource the scanner has ever produced:

```bash
swamp data get repo-scanner scan --json
```

## Scheduling

For a recurring nightly scan, drive the workflow from a small wrapper
script invoked by cron. Refresh any short-lived credentials (e.g. RDS
IAM tokens for a fact-store downstream) inside the wrapper before
calling `swamp workflow run`.
