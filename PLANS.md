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
