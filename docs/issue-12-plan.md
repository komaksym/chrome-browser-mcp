# Issue #12: Idempotent spawning and bounded workers

## Objective

Make `spawn_agents` safe to retry and keep the runtime-wide number of active
ChatGPT workers within a configurable ceiling while preserving each run's
logical job set and per-run concurrency limit.

## System-level completion DAG

```text
MCP request_id + arguments
            |
            v
   fingerprint / request map
       /              \
      v                v
 replay one run    stable conflict
      |
      v
 logical jobs -> global scheduler -> reserved worker slots (default: 2)
                                      |
                                      v
                         browser tabs / model submissions
```

## Test seams

- `AgentRuntime`: concurrent replay, conflict detection, queueing, and
  cross-run active-worker limits.
- `spawn_agents` MCP tool: request identity schema and stable error behavior.
