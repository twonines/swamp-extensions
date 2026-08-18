# `@twonines/doc-fact-checker`

Fact-check one Markdown document's facts and assumptions through Swamp. The
model is read-only, uses Kiro CLI by default, optionally supports Claude CLI,
and persists a provider-neutral `fact-check` resource. It checks facts and
assumptions; it does not judge decisions, recommendations, writing quality, or
style.

## Install

For this repository's local source:

```sh
swamp extension source add extensions/models --only models
swamp extension source add extensions/reports --only reports
```

For a published package, install it with Swamp rather than invoking either
provider directly:

```sh
swamp extension pull @twonines/doc-fact-checker
```

The extension exposes model `@twonines/doc-fact-checker`, method `review`,
resource `fact-check`, and report `@twonines/doc-fact-review`.

## Defaults and compatibility

The provider-neutral API defaults to Kiro:

- `cli=kiro`, `model=auto`, and `agent=doc-fact-checker`;
- Kiro trusted categories `read,grep,glob,web` when web verification is
  requested;
- `allowWeb=true`, which requests web verification but never assumes that the
  selected profile, authentication, or runtime can provide it.

Set `allowWeb=false` for an explicit repository-only review. The model then
removes `web` from the trusted categories, records web as disabled, and tells
the selected agent to mark external-only claims `unverifiable`. When web was
requested but unavailable, Kiro continues with repository-only checking and
records `webStatus=unavailable`; a classified Kiro web-startup rejection may
retry once with the same Kiro executable without web. It is never retried with
Claude.

The package supports both Kiro profile formats:

- Kiro v3: use the canonical Markdown profile at
  `kiro/agents/doc-fact-checker.md`;
- Kiro CLI 2.x: use the legacy JSON profile at
  `kiro/agents/doc-fact-checker.json`.

The installed Kiro CLI must support the selected profile format. In particular,
legacy 2.x `agent validate` commands validate the JSON asset; use Kiro v3
tooling or the package's conservative inspector for the Markdown profile.

When migrating from the original Claude-specific interface, configure the
provider-neutral `cli`, `cliPath`, `model`, `agent`, and `trustedTools` inputs.
The removed `claudePath`, `kiroPath`, `kiroModel`, `kiroAgent`, and
`kiroTrustTools` inputs are not accepted. New resources write `agentAvailable`
and selected-provider metadata; the report reader still accepts historical
`claudeAvailable` data for compatibility. The selected provider is always the
only provider executed.

## Authentication

Kiro headless execution must be authenticated in the environment used by Swamp.
For installations that use API-key authentication:

```sh
export KIRO_API_KEY='use-your-secret-manager-or-shell-environment'
```

Do not put API keys in model inputs, Markdown documents, profile files, this
README, or the repository. Kiro's normal configured login may be used instead
when it supplies credentials to `kiro-cli`. Claude authentication is handled by
Claude CLI's configured environment/login when `cli=claude` is explicitly
selected.

## Run a Kiro review

Kiro is the default, but the provider is explicit in this example:

```sh
swamp model @twonines/doc-fact-checker method run review doc-fact-checker \
  --input path=README.md \
  --input repoRoot=. \
  --input cli=kiro \
  --input model=auto \
  --input agent=doc-fact-checker
```

The model owns the provider boundary. Do not replace this command with a direct
`kiro-cli` invocation for user-facing reviews.

With web verification disabled:

```sh
swamp model @twonines/doc-fact-checker method run review doc-fact-checker \
  --input path=README.md \
  --input repoRoot=. \
  --input cli=kiro \
  --input allowWeb=false
```

When web access is unavailable, Kiro continues with repository-only checking;
claims requiring external pages or repositories not present locally are marked
`unverifiable`.

## Run with Claude explicitly

Claude is never selected as a fallback. Select it only when requested:

```sh
swamp model @twonines/doc-fact-checker method run review doc-fact-checker \
  --input path=README.md \
  --input repoRoot=. \
  --input cli=claude \
  --input model=sonnet \
  --input allowWeb=true
```

Only the selected CLI is started. If that CLI is unavailable, times out, exits
unsuccessfully, returns malformed JSON, or fails schema validation, the result
is inconclusive (`completed: false`, `ok: false`); the other provider is not
tried.

## Provider-neutral inputs

| Input              | Default              | Meaning                                                                                                                                  |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`              | `kiro`               | Selected provider: `kiro` or `claude`.                                                                                                   |
| `cliPath`          | empty                | Optional executable override; otherwise `kiro-cli` or `claude`.                                                                          |
| `model`            | `auto`               | Model identifier for the selected provider.                                                                                              |
| `agent`            | `doc-fact-checker`   | Kiro profile name; ignored by Claude.                                                                                                    |
| `trustedTools`     | `read,grep,glob,web` | Kiro categories trusted without confirmation. Only safe read/search/web categories survive normalization; `allowWeb=false` strips `web`. |
| `repoRoot`         | `.`                  | Working directory and repository boundary.                                                                                               |
| `wallTimeoutMs`    | `600000`             | Hard deadline in milliseconds for the selected invocation.                                                                               |
| `allowWeb`         | `true`               | Requests external verification; it does not guarantee web access.                                                                        |
| `guidance`         | empty                | Additional document-specific focus; it cannot relax security or tool restrictions.                                                       |
| `maxDocumentChars` | `120000`             | Maximum document size included in the prompt. Oversized input is rejected, never silently truncated.                                     |

The API intentionally does not expose provider-specific `claudePath`,
`kiroPath`, `kiroModel`, `kiroAgent`, or `kiroTrustTools` inputs.

## Kiro profiles

The package includes portable profile assets:

- `kiro/agents/doc-fact-checker.md` — canonical Kiro v3 Markdown profile;
- `kiro/agents/doc-fact-checker.json` — legacy Kiro CLI 2.x JSON profile;
- `kiro/skills/doc-fact-checker/SKILL.md` — portable Swamp-routing skill.

Install them only when you choose to configure a consumer repository. The
extension does not modify consumer `.kiro` directories automatically. For
example, from a checked-out package or source tree:

```sh
mkdir -p .kiro/agents .kiro/skills/doc-fact-checker
cp kiro/agents/doc-fact-checker.md .kiro/agents/doc-fact-checker.md
cp kiro/skills/doc-fact-checker/SKILL.md \
  .kiro/skills/doc-fact-checker/SKILL.md
```

Use the JSON profile instead of the Markdown profile for Kiro CLI 2.x:

```sh
cp kiro/agents/doc-fact-checker.json .kiro/agents/doc-fact-checker.json
```

The profile exposes repository read/search tools and optional read-only web
tools. It excludes write, shell, MCP, subagent, power, context, and wildcard
access, denies filesystem writes and shell execution, and excludes common secret
paths. `agent=<profile-name>` selects a custom profile, but custom profiles are
supported only if they preserve this read-only contract. An uninspectable
profile is never treated as broader permission; its capability state is recorded
as unknown or unavailable.

## Web capability

`allowWeb` is a request, not a guarantee.

- Kiro uses web verification only when the selected profile exposes the `web`
  category and its `web_fetch`/`web_search` capabilities are available.
- If Kiro cannot use web tools, the same Kiro executable may be retried once
  without web trust when the failure is classified as a web-capability startup
  rejection. It is never retried with Claude.
- Claude uses its fixed read-only repository tools and adds `WebFetch` and
  `WebSearch` only when `allowWeb=true`.
- Repository-read and web status are reported independently in
  `capabilities.webStatus` (`disabled`, `enabled`, `unavailable`, or `unknown`).

## Security and resource limits

The model applies defense in depth:

1. It resolves the document under `repoRoot` and rejects paths outside that
   boundary before starting a provider.
2. It rejects documents larger than `maxDocumentChars` before spawning a
   provider; it never truncates silently.
3. It treats document content and operator guidance as untrusted data and
   repeats the JSON output contract after the document delimiter.
4. It uses only validated read-only tool categories for Kiro and fixed read-only
   allowlists for Claude. It never uses Kiro `--trust-all-tools`.
5. It parses only the expected JSON payload and validates findings with Zod.
6. It limits failure logging to metadata and output lengths rather than logging
   provider output or document contents.

`wallTimeoutMs` is a hard deadline. An expired invocation is aborted and
persisted as `timedOut: true` with `failureKind: timeout`; it does not trigger
provider fallback. The report identifies inconclusive execution separately from
a completed review.

## Cost and usage

The extension does not estimate or invent provider costs. Prompt size is bounded
by `maxDocumentChars`, and `documentChars` and `promptChars` are persisted for
inspection. Optional `usage` metadata is provider-supplied only when available;
absent usage is not filled with an estimate. Actual Kiro or Claude billing
remains subject to the selected provider, model, account, and network/web usage.

## Read the persisted result

Read the human-readable report through Swamp:

```sh
swamp report get @twonines/doc-fact-review --model doc-fact-checker --markdown
```

For structured data:

```sh
swamp data get doc-fact-checker --json
```

When composing persisted output with other Swamp data, use CEL expressions such
as:

```text
data.latest("doc-fact-checker", "fact-check").attributes.findings
```

Do not fetch the document again or invoke a provider CLI directly for a
user-facing fact-check.
