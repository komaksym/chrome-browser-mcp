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
4. Validate source, generated runtime artifacts, tests, and the real browser
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
   checks, and the available end-to-end validation; review and commit the
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

# Issue #37: Strict two-worker live ChatGPT code-review smoke

## Summary

Add a separate opt-in headed-Chrome test that submits the strict
`@skills-mcp /code-review` request through a fresh real ChatGPT conversation.
The parent must route through the configured MCP app, create exactly two new
independent worker conversations, and return a verified two-result barrier for
the configured canary PR. The test owns only the tabs and browser state it
creates, and preserves bounded diagnostics on failure.

## Milestones

1. Add public live-run helpers for canary pinning, strict prompt construction,
   target correlation, profile isolation, and sanitized diagnostics.
2. Add the live headed-Chrome runner using the real composer/send UI and the
   existing native-host/MCP startup seam; keep worker creation and collection
   exclusively parent-driven through ChatGPT.
3. Add focused helper tests and document the one-command opt-in setup,
   authentication, tunnel, cleanup, and artifact rules.
4. Run focused tests, typecheck, lint, the full test suite, artifact/version
   checks, and the available deterministic E2E; review and commit.

## System-level completion DAG

```text
configured canary PR
        |
        v
unique run identity + pinned base/head
        |
        v
fresh real ChatGPT parent composer
        |
        v
@skills-mcp /code-review -> configured chrome-mcp tunnel
        |
        v
exactly two new worker targets in parent window
        |
        +--> distinct worker prompts + completion evidence
        |
        v
parent collect_agents barrier.satisfied=true
        |
        v
parent response contains both results -> owned cleanup/diagnostics
```

## Test seams

- Pure live-run helpers: prompt/canary construction, target-delta
  correlation, configuration isolation, and URL/diagnostic sanitization.
- Real Playwright/CDP page: fresh parent creation, visible composer submission,
  worker target creation, background visibility, and parent result delivery.
- Direct MCP calls only for setup/status and read-only focus diagnostics; the
  acceptance path never calls `spawn_agents`, `collect_agents`, or
  `cancel_agents` from the test itself.

# Dual Chrome profiles: second extension/host/port flavor (0.1.18)

## TLDR

1. Scope: run two isolated bridges at once — profile 1 keeps extension
   `jlpddlfiallighiohmhhkemgbhofpnha` on `:2091`, profile 2 gets a new
   extension `doommfidfcljgehkppgiinjdjnafcmdc` on `:2093`. No behavior change
   for single-instance users.
2. Out of scope: sharing one tunnel across two ChatGPT accounts (tunnels are
   org-scoped); a second ChatGPT account still needs its own tunnel ID, and
   only one `verify:local` target per command.
3. Single source of truth: new `scripts/instances.json` (ports, host names,
   extension IDs, public keys, dist dirs). Build, installer, and verifier all
   read it — no new hardcoded copies.
4. Deferred: e2e coverage for instance 2 (instance-1 e2e is the regression
   gate); per-profile auto port fallback (rejected — nondeterministic
   profile-to-port mapping would cross wire two accounts' tabs).

## High-Level Flow

```text
scripts/instances.json
  +-- build-extension.mjs --> dist/extension + dist/extension2 (per-flavor HOST_NAME define)
  +-- install-macos.sh --> 2 wrappers (baked CHROME_MCP_PORT + EXPECTED_ORIGIN) + 2 host manifests
  +-- verify-local.mjs --> port-keyed expected extension-ID assertion
Chrome profile 1 (ext 1) -> host 1 -> bridge :2091 -> tunnel chrome-browser-mcp -> ChatGPT acct 1
Chrome profile 2 (ext 2) -> host 2 -> bridge :2093 -> tunnel chrome-browser-mcp-2 -> ChatGPT acct 2
```

## Milestones

1. `instances.json`, build both flavors, `HOST_NAME` define with test-safe
   fallback, `CHROME_MCP_EXPECTED_ORIGIN` in the bridge.
2. Installer/uninstaller for both manifests/wrappers; `configure-tunnel.sh`
   accepts profile + URL for the second tunnel.
3. Verifier asserts the expected extension ID per port; `verify:local2` script.
4. Unit tests (installer both flavors, instances consistency, host fallback,
   tracked artifacts incl. `dist/extension2/*`); bump to 0.1.18; rebuild dist;
   README + CHATGPT_SETUP dual-profile docs.
5. Run typecheck, lint, vitest, artifacts/version checks; e2e if a browser is
   available. Commit (dist is tracked runtime) only on explicit approval.

# Three logical Chrome instances: fixed routing for current, subscription, and agent profiles

## Summary

Extend the existing two-flavor topology to three explicitly named Chrome
instances. Each instance owns one extension/native-host flavor, one loopback
port, and one machine-local tunnel profile. Configuration commands derive all
routing values from `instances.json` so a tunnel cannot be pointed at another
instance's browser port by accident.

## System-level completion DAG

```text
instances.json
  +--> build + install --> extension/native host flavor N
  +--> configure tunnel --> profile N -> fixed loopback port N
  +--> verify local ----> expected extension identity
                              |
                              v
                     ChatGPT account N
```

## Milestones

1. Add the third stable extension key/ID and port `2095`; keep `2092` reserved
   for Skills MCP and preserve existing IDs/ports.
2. Make tunnel configuration instance-name driven and reject arbitrary
   profile/URL combinations that can cross-route browser access.
3. Extend installer, verifier, tests, tracked artifacts, and setup docs for
   the third instance; document that one matching flavor is loaded per Chrome
   profile.
4. Run focused tests, typecheck, lint, build, artifact/version checks, and
   review without touching unrelated dirty changes.
