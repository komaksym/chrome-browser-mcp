# Plan: Two-profile Chrome MCP with safe diagnostics

> **For the implementation agent:** Execute this plan task-by-task in the current checkout. Update the existing PR #43 branch in place.

**Goal:** Produce a clean two-profile Chrome MCP merge candidate and add safe, actionable local diagnostics for browser-bridge and browser-backed worker failures.

**Architecture:** `scripts/instances.json` remains the single topology source of truth. The bridge receives one optional diagnostics logger, which projects only allowlisted operational fields into stderr and optional JSONL output. The logger keeps a bounded in-memory summary for `browser_status`; it never receives prompts, page content, cookies, tokens, or full URLs.

**Validation:** Focused Vitest tests first, then typecheck, lint, full Vitest, version/artifact checks, audit, and a final diff review. The live/automated ChatGPT E2E harness is intentionally removed; the manual smoke checklist remains in `docs/CHATGPT_SETUP.md`.

## Task 1: Reduce the checked-in topology to two profiles

**Files:** `scripts/instances.json`, `scripts/configure-tunnel.sh`, `scripts/uninstall-macos.sh`, `README.md`, `docs/CHATGPT_SETUP.md`, `tests/unit/configureTunnel.test.mjs`, `tests/unit/instances.test.ts`

1. Remove only the `chrome3` record and all user-facing agent-profile instructions.
2. Keep `chrome` and `chrome2` ports, extension IDs, host names, tunnel profiles, and runtime-key references unchanged.
3. Update tests to assert exactly two isolated instances and `chrome2` routing.
4. Rebuild so `dist/extension3` disappears and the bridge/extension artifacts match the source.

## Task 2: Add the diagnostics logger with tests first

**Files:** `src/bridge/diagnosticsLogger.ts`, `tests/unit/diagnosticsLogger.test.ts`

1. Add failing tests for `off`, `error`, `info`, and `debug` filtering; JSONL serialization; bounded last-event summary; and omission/redaction of sensitive field names and values.
2. Implement a logger that never throws into request handling, writes to stderr at the selected level, and appends to `CHROME_MCP_LOG_FILE` when configured.
3. Keep only a bounded event count and last safe event in memory; expose level, configured file path, and write-error count as the status summary.

## Task 3: Instrument browser, runtime, and MCP seams

**Files:** `src/bridge/browserClient.ts`, `src/bridge/agentRuntime.ts`, `src/bridge/mcpServer.ts`, `src/bridge/index.ts`, relevant integration/unit tests

1. Make logger injection optional so existing constructors and test doubles remain compatible.
2. Log browser ready/disconnect, request method/duration/outcome, agent run/job state transitions, worker tab open/close, retry/recovery, and terminal failure using IDs, codes, states, counts, and bounded tab metadata only.
3. Wrap `spawn_agents`, `collect_agents`, and `cancel_agents` with request start/end/error events without logging their arguments or returned content.
4. Return a safe diagnostics summary from `browser_status` and add an assertion that no sensitive data is present.

## Task 4: Make local collection easy and instance-safe

**Files:** `scripts/install-macos.sh`, `README.md`, `docs/CHATGPT_SETUP.md`, generated wrappers under `dist` as applicable

1. Have generated wrappers select a per-instance default log file under the user log directory while honoring explicit environment overrides.
2. Keep the default level low-noise and make `debug` opt-in for investigations.
3. Document the two profile-specific log paths, the exact verification commands, and the redaction boundary.

## Task 5: Validate and publish the focused PR

1. Run focused logger/topology/MCP tests and fix failures.
2. Run typecheck, lint, full tests, version/artifact checks, and audit.
3. Confirm `git diff origin/main...HEAD` contains no live ChatGPT test files and no `chrome3` topology.
4. Commit with a short subject and detailed body, then push the simplified change to `codex/three-profile-mcp-chrome-pr` so PR #43 remains the review surface.
5. Update PR #43’s title and body with the two-profile scope, completion DAG, and validation results; leave the PR open.
