import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";
import type { BrowserLifecycleEvent } from "../../src/bridge/types.js";

function completionMarker(prompt: string): string {
  const marker = prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${prompt}`);
  return marker;
}

async function flushUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function lifecycleHarness() {
  let lifecycleListener: ((event: BrowserLifecycleEvent) => void) | undefined;
  const submitted = new Map<number, string>();
  const forgotten: number[] = [];
  const closed: number[] = [];
  let openCalls = 0;
  const browser = {
    subscribeLifecycle: (listener: (event: BrowserLifecycleEvent) => void) => {
      lifecycleListener = listener;
      return () => {
        if (lifecycleListener === listener) lifecycleListener = undefined;
      };
    },
    request: (method: string, args: Record<string, unknown> = {}) => {
      if (method === "resolve_chatgpt_anchor") {
        return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
      }
      if (method === "open_agent_worker_tab") {
        openCalls += 1;
        return Promise.resolve({ tab: { tabId: openCalls } });
      }
      if (method === "chatgpt_worker_submit") {
        submitted.set(args.tabId as number, args.prompt as string);
        return Promise.resolve({ submitted: true });
      }
      if (method === "read_chatgpt_worker") {
        const prompt = submitted.get(args.tabId as number);
        if (!prompt) throw new Error("missing submitted prompt");
        return Promise.resolve({
          ready: true,
          generating: true,
          latestUserText: prompt,
          latestUserTruncated: false,
          latestAssistantText: null,
          latestAssistantTruncated: false,
        });
      }
      if (method === "read_chatgpt_worker_snapshot") return Promise.resolve({});
      if (method === "close_tab") {
        closed.push(args.tabId as number);
        return Promise.resolve({ closed: true });
      }
      return Promise.resolve({});
    },
    latestChatGptWorkerSnapshot: () => undefined,
    forgetChatGptWorkerSnapshot: (tabId: number) => {
      forgotten.push(tabId);
    },
  } as unknown as BrowserClient;

  return {
    browser,
    submitted,
    forgotten,
    closed,
    emit: (event: BrowserLifecycleEvent) => lifecycleListener?.(event),
    openCalls: () => openCalls,
  };
}

describe("AgentRuntime worker lease behavior", () => {
  it("releases capacity before retry when transient dispatch never created a worker tab", async () => {
    const submitted = new Map<number, string>();
    let openCalls = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        }
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          if (openCalls === 1) {
            return Promise.reject(new BrowserError("BROWSER_DISCONNECTED", "lost before worker tab creation"));
          }
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `done\n${completionMarker(prompt)}`,
          });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const first = await runtime.spawnAgents([{ agent_id: "first", prompt: "first" }], 1, "lease-retry-first");
    expect(first.jobs[0]).toMatchObject({ state: "FAILED_TRANSIENT", recoverable: true });

    const second = await runtime.spawnAgents([{ agent_id: "second", prompt: "second" }], 1, "lease-retry-second");
    expect(second.jobs[0]?.state).toBe("DISPATCHED");
    expect(openCalls).toBe(2);

    const blockedRetry = await runtime.collectAgents(first.run_id);
    expect(blockedRetry.pending[0]?.state).toBe("FAILED_TRANSIENT");
    expect(openCalls).toBe(2);

    await runtime.collectAgents(second.run_id);
    expect(openCalls).toBe(3);

    const recovered = await runtime.collectAgents(first.run_id);
    expect(recovered.state).toBe("COMPLETE");
  });

  it("retains capacity across a recoverable transient failure while the worker tab still exists", async () => {
    const submitted = new Map<number, string>();
    let openCalls = 0;
    let firstTabReads = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        }
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const tabId = args.tabId as number;
          if (tabId === 1) {
            firstTabReads += 1;
            if (firstTabReads === 1) {
              return Promise.reject(new BrowserError("BROWSER_DISCONNECTED", "temporary read failure"));
            }
          }
          const prompt = submitted.get(tabId);
          if (!prompt) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `done\n${completionMarker(prompt)}`,
          });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const first = await runtime.spawnAgents([{ agent_id: "first", prompt: "first" }], 1, "retain-first");
    const second = await runtime.spawnAgents([{ agent_id: "second", prompt: "second" }], 1, "retain-second");
    expect(second.jobs[0]?.state).toBe("CREATED");

    const transient = await runtime.collectAgents(first.run_id);
    expect(transient.pending[0]?.state).toBe("FAILED_TRANSIENT");

    const stillBlocked = await runtime.collectAgents(second.run_id);
    expect(stillBlocked.pending[0]?.state).toBe("CREATED");
    expect(openCalls).toBe(1);

    await runtime.collectAgents(first.run_id);
    expect(openCalls).toBe(2);
  });

  it("keeps verified worker-tab ownership private after its active capacity is released", async () => {
    const submitted = new Map<number, string>();
    let openCalls = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        }
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `done\n${completionMarker(prompt)}`,
          });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "first" },
        { agent_id: "second", prompt: "second" },
      ],
      1,
      "privacy-after-release",
    );

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(collected.results).toHaveLength(1);
    expect(collected.pending[0]?.state).toBe("DISPATCHED");
    expect(runtime.isWorkerTab(1)).toBe(true);
    expect(openCalls).toBe(2);
  });

  it("keeps cancellation release idempotent without disturbing a newer dispatch lease", async () => {
    const submitted = new Map<number, string>();
    let openCalls = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        }
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `done\n${completionMarker(prompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const first = await runtime.spawnAgents([{ agent_id: "first", prompt: "first" }], 1, "cancel-first");
    const second = await runtime.spawnAgents([{ agent_id: "second", prompt: "second" }], 1, "cancel-second");
    expect(second.jobs[0]?.state).toBe("CREATED");

    const cancelled = await runtime.cancelAgents(first.run_id);
    expect(cancelled.jobs[0]?.state).toBe("CANCELLED");
    expect(openCalls).toBe(2);

    await runtime.cancelAgents(first.run_id);
    expect(openCalls).toBe(2);

    const completedSecond = await runtime.collectAgents(second.run_id);
    expect(completedSecond.state).toBe("COMPLETE");
    expect(openCalls).toBe(2);
  });

  it("terminalizes a removed current worker and dispatches queued work without collection", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "first" },
        { agent_id: "second", prompt: "second" },
        { agent_id: "third", prompt: "third" },
      ],
      1,
      "worker-removal-capacity",
    );
    expect(harness.openCalls()).toBe(1);

    harness.emit({ type: "agent_worker_tab_removed", tabId: 1 });
    await flushUntil(
      () => harness.openCalls() === 2,
      "queued work was not dispatched after the worker tab removal",
    );

    const view = await runtime.collectAgents(spawned.run_id);
    expect(view.failed).toMatchObject([
      {
        agent_id: "first",
        state: "FAILED_TERMINAL",
        error: {
          code: "WORKER_TAB_CLOSED",
          retryable: false,
        },
      },
    ]);
    expect(runtime.isWorkerTab(1)).toBe(false);

    harness.emit({ type: "agent_worker_tab_removed", tabId: 1 });
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(harness.openCalls()).toBe(2);
  });

  it("preserves a verified result when its released worker tab is removed later", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "first" },
        { agent_id: "second", prompt: "second" },
      ],
      1,
      "verified-then-removed",
    );
    const prompt = harness.submitted.get(1);
    if (!prompt) throw new Error("expected first submitted prompt");

    harness.emit({
      type: "chatgpt_worker_snapshot",
      tabId: 1,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: prompt,
        latestUserTruncated: false,
        latestAssistantText: `verified answer\n${completionMarker(prompt)}`,
        latestAssistantTruncated: false,
        revision: 1,
        timestamp: Date.now() + 1_000,
      },
    });
    await flushUntil(() => harness.openCalls() === 2, "verified completion did not release capacity");
    expect(runtime.isWorkerTab(1)).toBe(true);

    harness.emit({ type: "agent_worker_tab_removed", tabId: 1 });
    await flushUntil(() => !runtime.isWorkerTab(1), "verified worker ownership was not cleaned up");

    const view = await runtime.collectAgents(spawned.run_id);
    expect(view.results).toMatchObject([
      {
        agent_id: "first",
        state: "VERIFIED_DONE",
        result: { type: "text", text: "verified answer" },
      },
    ]);
    expect(view.failed).toEqual([]);
  });

  it("lets cancellation win a racing removal without double-releasing a newer lease", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const first = await runtime.spawnAgents([{ agent_id: "first", prompt: "first" }], 1, "cancel-race-first");
    await runtime.spawnAgents([{ agent_id: "second", prompt: "second" }], 1, "cancel-race-second");
    expect(harness.openCalls()).toBe(1);

    const cancelling = runtime.cancelAgents(first.run_id);
    harness.emit({ type: "agent_worker_tab_removed", tabId: 1 });
    const cancelled = await cancelling;

    expect(cancelled.jobs[0]).toMatchObject({ state: "CANCELLED" });
    await flushUntil(() => harness.openCalls() === 2, "cancellation did not release capacity");

    harness.emit({ type: "agent_worker_tab_removed", tabId: 1 });
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(harness.openCalls()).toBe(2);
  });

});
