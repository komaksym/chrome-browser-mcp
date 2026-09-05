# Plan: Two-profile Chrome MCP with safe diagnostics (completed)

> Status: completed and merged in [PR #43](https://github.com/komaksym/chrome-browser-mcp/pull/43).

## Outcome

The repository now supports exactly two isolated Chrome MCP routes: `chrome`
for the current profile and `chrome2` for the second subscription profile.
The third/agent route and the live/automated ChatGPT E2E harness were removed.
The manual ChatGPT smoke checklist remains the supported real-user check.

## Architecture delivered

`scripts/instances.json` remains the topology source of truth. The bridge uses
an optional diagnostics logger that projects allowlisted operational fields to
stderr and optional JSONL output. Its bounded `browser_status` summary and
per-profile logs never record prompts, page content, cookies, credentials,
tokens, or full URLs.

```text
ChatGPT tool call / browser event
              |
              v
      safe event projection
              |
       stderr + JSONL log
              |
              v
       browser_status summary
              |
              v
      manual, reproducible diagnosis
```

## Validation recorded by the merge

- Focused and full Vitest checks passed.
- Typecheck, lint, version, runtime-artifact, and dependency-audit checks
  passed.
- The live/automated ChatGPT E2E harness is intentionally absent; the manual
  checklist is in `docs/CHATGPT_SETUP.md`.

## Superseded work

The original implementation plan also considered a dedicated authenticated
profile, live headed ChatGPT automation, and controlled CI/nightly execution.
That direction is closed as not planned in
[issue #35](https://github.com/komaksym/chrome-browser-mcp/issues/35). Do not
reopen or extend it without an explicit product decision.
