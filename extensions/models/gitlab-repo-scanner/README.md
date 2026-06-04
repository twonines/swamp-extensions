# @twonines/gitlab-repo-scanner

Scans a GitLab repository and returns structured metadata, a recursive file
tree, and the contents of high-signal files. A companion `fetch_files` method
lets you retrieve any file discovered in the tree on demand.

## Authentication

Requires a GitLab personal access token with `read_api` scope, stored in a
swamp vault.

## Usage

```bash
# Create model
swamp model create @twonines/gitlab-repo-scanner my-scanner \
  --global-arg url=https://gitlab.example.com \
  --global-arg 'token=${{ vault.get(gitlab-secrets, TOKEN) }}'

# Scan a repository
swamp model method run my-scanner scan --input projectPath=myorg/my-service

# Fetch specific files spotted in the tree
swamp model method run my-scanner fetch_files \
  --input projectPath=myorg/my-service \
  --input '{"paths": ["k8s/deployment.yaml", "docs/architecture.md"]}'
```

## Methods

### `scan`

Scans a single repository. Returns:

- **Metadata** — name, description, default branch, last activity, visibility,
  star/fork counts, topics
- **Languages** — percentage breakdown from GitLab's language detection
- **Contributors** — top 20 by commit count
- **File tree** — recursive list of all paths (type: blob/tree), up to 500
  entries
- **Known files** — contents of high-signal files that exist in the tree:
  `.gitlab-ci.yml`, `go.mod`, `Cargo.toml`, `package.json`, `pom.xml`,
  `requirements.txt`, `pyproject.toml`, `Dockerfile`, `docker-compose.yml`,
  `Makefile`, `README.md` (first 2KB)

**Arguments**

| Name          | Type   | Description                          |
| ------------- | ------ | ------------------------------------ |
| `projectPath` | string | Repository path (e.g. `myorg/repo`) |

### `fetch_files`

Fetches the raw content of specific files by path. Use this after `scan` to
retrieve files spotted in the file tree that are not in the high-signal list.
Each file is capped at 32KB.

**Arguments**

| Name          | Type     | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `projectPath` | string   | Repository path (e.g. `myorg/repo`)                  |
| `branch`      | string?  | Branch to read from (defaults to default branch)     |
| `paths`       | string[] | File paths relative to repo root                     |

## CEL Reference

After running `scan`, reference the output in workflows:

```
# Number of files in tree
data.latest("my-scanner", "myorg/my-service").attributes.fileTree

# Default branch
data.latest("my-scanner", "myorg/my-service").attributes.defaultBranch

# Contents of go.mod (if present)
data.latest("my-scanner", "myorg/my-service").attributes.knownFiles
```
