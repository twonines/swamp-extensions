# @twonines/git-workspace

Local git operations model for swamp — clone, branch, read, commit, push.

Designed for agent-driven development workflows where code changes are authored
locally and pushed to a remote forge. Pairs naturally with `@webframp/gitlab`
(or any forge model) for MR/PR creation after push.

## Workspace Layout

By default, repos are cloned to `$HOME/{host}/{group}/{project}`:

```
~/gitlab.example.com/team/my-service/
~/codeberg.org/myorg/my-extensions/
```

Override with the `baseDir` global argument or per-method `localPath` input.

## Quick Start

```bash
swamp model create @twonines/git-workspace workspace \
  --global-arg host=gitlab.example.com \
  --global-arg 'commitFormat=leading-verb imperative, ≤50 char title, body explains why'
```

```bash
# Clone or update a repo
swamp model method run workspace ensure --input project=team/my-service

# Create a feature branch
swamp model method run workspace branch \
  --input project=team/my-service \
  --input branch=feat/add-dns-record

# Read a file
swamp model method run workspace read_file \
  --input project=team/my-service \
  --input path=terraform/main.tf

# List files matching a pattern
swamp model method run workspace list_files \
  --input project=team/my-service \
  --input 'pattern=**/*.tf'

# Commit changes
swamp model method run workspace commit \
  --input project=team/my-service \
  --input 'message=Add TXT record for domain verification'

# Push the branch
swamp model method run workspace push \
  --input project=team/my-service
```

## Methods

| Method | Description |
|--------|-------------|
| `ensure` | Clone if missing, fetch+pull if exists. Auto-detects default branch from remote HEAD. |
| `branch` | Create a new branch from default branch HEAD. |
| `read_file` | Read a file from the workspace. |
| `list_files` | List tracked files matching a pattern (via `git ls-files`). |
| `commit` | Stage files and commit with a message. |
| `push` | Push current branch to origin with `-u` tracking. |

## Global Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `host` | yes | Git remote host (e.g. `gitlab.example.com`) |
| `baseDir` | no | Base directory for workspaces (default: `$HOME`) |
| `defaultBranch` | no | Fallback branch if auto-detection fails (default: `main`) |
| `commitFormat` | no | Commit message format guidance for agents |

## Composing with Forge Models

After pushing a branch, create an MR via `@webframp/gitlab`:

```bash
swamp model method run gitlab create_merge_request \
  --input project=team/my-service \
  --input title='Add TXT record for domain verification' \
  --input sourceBranch=feat/add-dns-record
```

## License

MIT — see LICENSE.md
