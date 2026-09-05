# Issue #13: ChatGPT streaming worker snapshots

## Objective

Capture the latest ChatGPT worker turn while it is rendering so collection can
survive DOM virtualization, while keeping snapshots ephemeral and inside the
existing extension/native-host/runtime trust boundary.

## Milestones

1. Add the bounded, monotonic per-page observation adapter.
2. Forward snapshots as unsolicited Native Messaging events and cache them only
   in runtime memory.
3. Prefer fresh, identity-checked snapshots during collection, then retain the
   existing direct DOM and recovery ladder as fallback.
4. Validate source, generated runtime artifacts, and the deterministic bridge
   path before committing and pushing.

## System-level completion DAG

```text
ChatGPT DOM mutations
        |
        v
Ephemeral observer -- bounded + monotonic --> snapshot event
        |                                      |
        +--> direct command result             v
                                      Extension -> Native host
                                                   |
                                                   v
                                      BrowserClient snapshot cache
                                                   |
                                                   v
                         fresh + identity + marker validation
                              /                         \
                             v                           v
                    verified MCP result       direct DOM/recovery fallback
```

## Test seams

- `runChatGptWorkerCommand`: mutation-driven observation, bounding, and
  virtualization retention.
- `BrowserClient` and MCP/AgentRuntime: event transport, freshness, identity,
  completion-marker validation, and snapshot-only completion.

# Issue #19: Background new tabs

## Objective

Keep user-created MCP tabs in the background by default while preserving an
explicit `active: true` opt-in for actions that require foreground focus.

## Milestones

1. Cover the MCP and extension tab-opening seams with default-background and
   explicit-foreground regression tests.
2. Change the public default and extension fallback, then document the focus
   behavior and bump the patch version.
3. Regenerate runtime artifacts and run the complete validation suite.

## System-level completion DAG

```text
MCP new_tab request
        |
        v
active omitted -> false; active: true -> true
        |
        v
Native bridge -> chrome.tabs.create({ active })
        |                         |
        v                         v
background tab              explicit foreground tab
keeps user's focus          becomes active when requested
```

## Test seams

- MCP HTTP `new_tab`: schema defaulting and explicit foreground forwarding.
- Extension native `new_tab`: Chrome tab-creation options for omitted and
  explicit `active` values.
- Manual browser verification: active-tab identity remains stable for
  background opens and changes only for an explicit foreground request.

# Issue #27: Reconcile stale worker leases

## Objective

Repair missed worker lifecycle events with bounded, evidence-based browser
observations so stale global capacity cannot keep dispatchable work queued.
Reconciliation is limited to blocked scheduler passes and browser reconnect;
it has no timer, lease TTL, prompt submission, DOM recovery ladder, reload, or
tab activation behavior.

## Milestones

1. Add failing regressions at the BrowserClient lifecycle and observable
   spawn/dispatch seams for missing-tab repair, reconnect repair, fresh terminal
   snapshot validation, and healthy-worker preservation.
2. Implement one serialized reconciliation path that compares leased worker
   tabs with `list_tabs`, reuses the existing removal/snapshot transitions, and
   wakes the scheduler only after capacity is actually released.
3. Bump the patch version, regenerate tracked bridge/extension artifacts, and
   document the repaired lifecycle boundary.
4. Run focused tests, typecheck/lint, the full test suite, artifact/version
   checks, and the available local validation; review and commit the
   completed change.

## System-level completion DAG

```text
blocked scheduler pass OR browser ready after reconnect
                         |
                         v
              bounded current tab observation
                         |
             +-----------+-----------+
             |                       |
       tab missing             fresh terminal snapshot
             |                       |
             v                       v
      WORKER_TAB_CLOSED       existing snapshot validator
             |                       |
             +-----------+-----------+
                         v
                  release exact lease
                         |
                         v
                 serialized scheduler
                         |
                         v
                    queued dispatch
```

## Test seams

- `BrowserClient` lifecycle subscription: reconnect-ready events clear stale
  snapshot cache before the runtime asks for fresh browser evidence.
- `AgentRuntime.spawnAgents` plus observable worker opening and
  `collectAgents`: a missing leased tab or a valid terminal snapshot frees the
  global slot and dispatches queued work without collection being the trigger.
- Existing lifecycle event validation: generating, stale, mismatched, and
  malformed evidence must retain capacity and avoid oversubscription.

# Two-profile Chrome MCP with safe diagnostics

## Objective

Update the existing multi-profile PR in place so it supports only the current
Chrome profile and the second subscription profile. Remove the agent-profile
route and automated/live E2E harness while retaining the manual ChatGPT smoke
checklist. Add opt-in, local, structured diagnostics that make browser bridge
and browser-backed worker failures actionable without recording prompts, page
content, credentials, cookies, or full URLs.

## Milestones

1. Remove the agent profile from the checked-in topology, documentation, tunnel
   validation, uninstall paths, and topology tests; regenerate only the two
   supported extension artifacts.
2. Add a bounded diagnostics logger with safe event fields, configurable level
   and file output, and integrate it at MCP requests, browser transport, and
   agent-runtime lifecycle seams.
3. Expose only a safe diagnostics summary through `browser_status` and document
   how to locate and collect per-profile logs for reproducible investigations.
4. Run focused tests, typecheck/lint, the complete test suite, version and
   artifact checks, and audit; review, commit, and push the simplified change
   to the existing PR #43 branch.

## System-level completion DAG

```text
ChatGPT tool call / browser event
              |
              v
      safe event projection
   (IDs, codes, state, timing only)
              |
              +--> stderr (launcher-visible)
              |
              +--> per-instance JSONL log (opt-in file)
              |
              v
       browser_status summary
              |
              v
     reproducible diagnosis without
       prompts, page text, or secrets
```

## Implementation tasks

1. Update `scripts/instances.json`, tunnel usage, uninstall paths, README, and
   `docs/CHATGPT_SETUP.md` for exactly `chrome` and `chrome2`.
2. Replace three-profile topology assertions with two-profile assertions and
   remove the automated/live E2E support that depends on a separate Chromium
   process or ChatGPT session.
3. Add `src/bridge/diagnosticsLogger.ts` and unit tests covering level filtering,
   JSONL output, bounded in-memory summary, and rejection of sensitive fields.
4. Inject the logger into `BrowserClient`, `AgentRuntime`, and MCP server
   request handlers; log lifecycle transitions and stable error codes only.
5. Set safe per-instance log defaults in the generated macOS wrappers, allow
   explicit `CHROME_MCP_LOG_LEVEL`/`CHROME_MCP_LOG_FILE` overrides, and document
   the two log locations and redaction boundary.
6. Add/adjust integration assertions for `browser_status` diagnostics, build
   the tracked runtime artifacts, and run all required validation commands.
