# @twonines/redmine-story-status

Read-only, evidence-backed status analysis for Redmine Stories. Use it to assess
progress, completion, blockers, readiness, and remaining work from current
Redmine data plus optional meeting, Teams, and GitLab evidence.

## Installation

```bash
swamp extension pull @twonines/redmine-story-status
```

## How it works

```text
Story + optional meeting files + optional Teams thread
                         |
                         v
       Redmine Story and child tasks are collected
                         |
                         v
       GitLab MR references are extracted and fetched
                         |
                         v
       Evidence is built, sanitized, and analyzed
                         |
                         v
       Cited status, progress, blockers, risks, and gaps
```

- Source collection runs in parallel.
- Teams retrieval is skipped when no `teamsThreadUrl` is supplied.
- The workflow is read-only.
- Source locators are preserved through analysis.

## Inputs

| Input            | Type         | Required | Default | Description                                                     |
| ---------------- | ------------ | :------: | ------- | --------------------------------------------------------------- |
| `storyId`        | integer      |   Yes    | —       | Numeric Redmine Story ID.                                       |
| `meetingFiles`   | string array |    No    | `[]`    | Paths to VTT, Markdown, or text meeting minutes.                |
| `teamsThreadUrl` | string       |    No    | `""`    | One Microsoft Teams message deep-link; the full thread is read. |

## Requirements

### Model instances

Create or configure these model instances with the exact names below:

| Instance         | Type                             | Used for                                               |
| ---------------- | -------------------------------- | ------------------------------------------------------ |
| `tracker`        | `@webframp/redmine`              | Story and child-task evidence.                         |
| `gitlab`         | `@webframp/gitlab`               | Referenced merge-request evidence.                     |
| `my-teams`       | `@webframp/microsoft/teams`      | Optional Teams thread evidence.                        |
| `story-analyzer` | `@twonines/redmine-story-status` | Meeting ingestion, evidence preparation, and analysis. |
| `sanitizer`      | `@mgreten/brief-sanitize`        | Source-text sanitization.                              |

Configure the target Redmine project on the `tracker` model. The project is
model configuration, not a workflow constant:

```yaml
globalArguments:
  project: your-redmine-project
```

The analyzer uses AWS Bedrock model `us.anthropic.claude-sonnet-4-20250514-v1:0`
in `us-east-1`.

### Vaults and access

| Vault             | Keys                                   | Required when                 |
| ----------------- | -------------------------------------- | ----------------------------- |
| `redmine-secrets` | `REDMINE_API_KEY`                      | Always.                       |
| `redmine-secrets` | `GITLAB_API_TOKEN`                     | GitLab evidence is fetched.   |
| `teams-secrets`   | `tenantId`, `clientId`, `refreshToken` | `teamsThreadUrl` is supplied. |

Also provide readable meeting-file paths and AWS runtime credentials with
Bedrock access. The analyzer model and the status report ship inside this
extension, so a single `swamp extension pull @twonines/redmine-story-status`
installs everything it needs.

## Usage

Redmine only:

```bash
export STORY_ID=123456
swamp workflow run @twonines/redmine-story-status \
  --input storyId="$STORY_ID"
```

With meeting and Teams context:

```bash
swamp workflow run @twonines/redmine-story-status \
  --input storyId="$STORY_ID" \
  --input 'meetingFiles=["path/to/meeting.vtt"]' \
  --input 'teamsThreadUrl=https://teams.microsoft.com/l/message/...'
```

Validate before running:

```bash
swamp workflow validate @twonines/redmine-story-status --json
```

## Output

The final analysis can include:

- analyzed status and confidence;
- summary and solved-when criteria;
- achieved and remaining work;
- open tasks and related merge requests;
- blockers, risks, questions, and data gaps;
- source citations and locators.

## Troubleshooting

If the workflow fails, inspect its report before retrying:

```bash
swamp report get @swamp/workflow-summary \
  --workflow @twonines/redmine-story-status \
  --json
```

Do not replace the workflow with direct Redmine, GitLab, Teams, Graph, `curl`,
or ad-hoc script calls.
