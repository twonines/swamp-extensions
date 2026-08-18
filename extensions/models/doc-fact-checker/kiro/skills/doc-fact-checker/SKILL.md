---
name: doc-fact-checker
description: Route Markdown fact-check requests through the Swamp document fact-checker model
---

# Document fact-checker routing

Use this skill when a user asks to fact-check, verify, validate, audit, or check
the accuracy of a Markdown document, ADR, runbook, guide, reference, or its
assumptions.

Do not invoke `kiro-cli`, Claude, web APIs, provider CLIs, or ad-hoc scripts
directly for a user-facing review. Route through the installed Swamp model so
the selected provider boundary is enforced and the result is persisted:

```sh
swamp model @twonines/doc-fact-checker method run review doc-fact-checker \
  --input path=<repo-relative-markdown-path> \
  --input repoRoot=. \
  --input cli=kiro \
  --input model=auto \
  --input agent=doc-fact-checker
```

The `review` method writes the `fact-check` resource. Read the human-readable
result through:

```sh
swamp report get @twonines/doc-fact-review --model doc-fact-checker --markdown
```

Use `swamp data get doc-fact-checker --json` or `swamp data query` for
structured persisted data. Prefer CEL expressions such as
`data.latest("doc-fact-checker", "fact-check").attributes.findings` when
composing it with other Swamp data. Do not re-fetch the document or bypass the
model with direct provider calls.

Kiro is the default provider. Its default trusted categories are
`read,grep,glob,web`; `allowWeb=false` explicitly strips `web` for
repository-only execution. `allowWeb=true` requests web verification but does
not guarantee it: profile, authentication, and runtime capabilities determine
whether web access is effective. Missing web access must leave external-only
claims `unverifiable`. The selected provider is never replaced by a fallback
provider. Use `--input cli=claude` only when the user explicitly selects Claude.

The model accepts provider-neutral inputs including `cliPath`, `model`, `agent`,
`trustedTools`, `repoRoot`, `wallTimeoutMs`, `allowWeb`, `guidance`, and
`maxDocumentChars`. Do not use the removed provider-specific names `claudePath`,
`kiroPath`, `kiroModel`, `kiroAgent`, or `kiroTrustTools`.

Consumers may copy the packaged profiles and this skill manually. Use
`kiro/agents/doc-fact-checker.md` with Kiro v3 and
`kiro/agents/doc-fact-checker.json` with legacy Kiro CLI 2.x installations;
consumer `.kiro` directories are never modified automatically. Custom profiles
must retain read-only repository access and must not add write, shell, MCP,
subagent, power, context, wildcard, or uninspectable permission broadening.
