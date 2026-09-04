import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";
import type { BrowserLifecycleEvent, ChatGptWorkerSnapshot } from "../../src/bridge/types.js";

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
  const snapshots = new Map<number, ChatGptWorkerSnapshot>();
  const forgotten: number[] = [];
  const closed: number[] = [];
  const liveTabs = new Set<number>();
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
        liveTabs.add(openCalls);
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
      if (method === "list_tabs") {
        return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
      }
      if (method === "close_tab") {
        const tabId = args.tabId as number;
        closed.push(tabId);
        liveTabs.delete(tabId);
        return Promise.resolve({ closed: true });
      }
      return Promise.resolve({});
    },
    latestChatGptWorkerSnapshot: (tabId: number) => {
      const snapshot = snapshots.get(tabId);
      return snapshot ? { ...snapshot } : undefined;
    },
    forgetChatGptWorkerSnapshot: (tabId: number) => {
      snapshots.delete(tabId);
      forgotten.push(tabId);
    },
    observeWorkerTabs: () => ({
      tabIds: new Set(liveTabs),
      snapshots: new Map<number, ChatGptWorkerSnapshot>(),
    }),
  } as unknown as BrowserClient;

  return {
    browser,
    submitted,
    forgotten,
    closed,
    emit: (event: BrowserLifecycleEvent) => lifecycleListener?.(event),
    cacheSnapshot: (tabId: number, snapshot: ChatGptWorkerSnapshot) => snapshots.set(tabId, snapshot),
    removeLiveTab: (tabId: number) => liveTabs.delete(tabId),
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

  it("reconciles a missing worker tab when blocked scheduling needs capacity", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const first = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-missing-tab",
    );
    expect(harness.openCalls()).toBe(1);

    expect(harness.removeLiveTab(1)).toBe(true);
    const second = await runtime.spawnAgents([{ agent_id: "new-run", prompt: "new run" }], 1, "reconcile-trigger");

    expect(harness.openCalls()).toBe(2);
    expect(second.jobs[0]?.state).toBe("CREATED");

    const view = await runtime.collectAgents(first.run_id);
    expect(view.failed).toMatchObject([
      {
        agent_id: "active",
        state: "FAILED_TERMINAL",
        error: { code: "WORKER_TAB_CLOSED", retryable: false },
      },
    ]);
    expect(view.pending).toMatchObject([
      { agent_id: "queued", state: "GENERATING" },
    ]);
  });

  it("preserves cached verified completion when reconciliation sees a missing worker tab", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const first = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-cached-completion",
    );
    const prompt = harness.submitted.get(1);
    if (!prompt) throw new Error("expected first submitted prompt");
    harness.cacheSnapshot(1, {
      ready: true,
      generating: false,
      latestUserText: prompt,
      latestUserTruncated: false,
      latestAssistantText: `verified answer\n${completionMarker(prompt)}`,
      latestAssistantTruncated: false,
      revision: 2,
      timestamp: Date.now() + 1_000,
    });
    expect(harness.removeLiveTab(1)).toBe(true);

    await runtime.spawnAgents([{ agent_id: "new-run", prompt: "new run" }], 1, "reconcile-cached-trigger");

    const view = await runtime.collectAgents(first.run_id);
    expect(view.results).toMatchObject([
      { agent_id: "active", result: { text: "verified answer" } },
    ]);
    expect(view.failed).toEqual([]);
  });

  it("reconciles a missing worker tab when the browser reconnects", async () => {
    const harness = lifecycleHarness();
    const runtime = new AgentRuntime(harness.browser, { maxActiveWorkers: 1 });
    const first = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconnect-missing-tab",
    );
    expect(harness.openCalls()).toBe(1);

    expect(harness.removeLiveTab(1)).toBe(true);
    harness.emit({ type: "ready", extensionVersion: "0.1.17", extensionId: "test-extension" });
    await flushUntil(() => harness.openCalls() === 2, "reconnect did not repair stale worker capacity");

    const view = await runtime.collectAgents(first.run_id);
    expect(view.failed).toMatchObject([
      {
        agent_id: "active",
        state: "FAILED_TERMINAL",
        error: { code: "WORKER_TAB_CLOSED", retryable: false },
      },
    ]);
  });

  it("reconciles a fresh terminal snapshot through the standard validation path", async () => {
    let nextTabId = 1;
    let terminalSnapshotAvailable = false;
    const cached = { snapshot: undefined as ChatGptWorkerSnapshot | undefined };
    let directReads = 0;
    let snapshotReads = 0;
    const submitted = new Map<number, { prompt: string; timestamp: number }>();
    const liveTabs = new Set<number>();
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        }
        if (method === "open_agent_worker_tab") {
          const tabId = nextTabId++;
          liveTabs.add(tabId);
          return Promise.resolve({ tab: { tabId } });
        }
        if (method === "chatgpt_worker_submit") {
          const tabId = args.tabId as number;
          const timestamp = Date.now();
          submitted.set(tabId, { prompt: args.prompt as string, timestamp });
          return Promise.resolve({ submitted: true, snapshot: { revision: 1, timestamp } });
        }
        if (method === "list_tabs") {
          return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
        }
        if (method === "read_chatgpt_worker_snapshot") {
          snapshotReads += 1;
          const tabId = args.tabId as number;
          const current = submitted.get(tabId);
          if (!terminalSnapshotAvailable || tabId !== 1 || !current) return Promise.resolve({});
          return Promise.resolve({
            snapshot: {
              ready: true,
              generating: false,
              latestUserText: current.prompt,
              latestUserTruncated: false,
              latestAssistantText: `Reconciled answer\n${completionMarker(current.prompt)}`,
              latestAssistantTruncated: false,
              revision: 2,
              timestamp: current.timestamp + 1,
            },
          });
        }
        if (method === "read_chatgpt_worker") {
          directReads += 1;
          const current = submitted.get(args.tabId as number);
          if (!current) throw new Error("missing submitted worker");
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: current.prompt,
            latestUserTruncated: false,
            latestAssistantText: null,
            latestAssistantTruncated: false,
          });
        }
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => cached.snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
      observeWorkerTabs: async () => {
        const tabIds = new Set(liveTabs);
        const snapshots = new Map<number, ChatGptWorkerSnapshot>();
        for (const tabId of tabIds) {
          const response = await browser.request("read_chatgpt_worker_snapshot", { tabId, afterRevision: 0 });
          const snapshot = (response as { snapshot?: ChatGptWorkerSnapshot }).snapshot;
          if (snapshot) snapshots.set(tabId, snapshot);
        }
        return { tabIds, snapshots };
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const first = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-terminal-snapshot",
    );
    expect(first.jobs[0]?.state).toBe("DISPATCHED");
    expect(first.jobs[1]?.state).toBe("CREATED");

    const firstSubmission = submitted.get(1);
    if (!firstSubmission) throw new Error("expected first worker submission");
    cached.snapshot = {
      ready: true,
      generating: true,
      latestUserText: firstSubmission.prompt,
      latestUserTruncated: false,
      latestAssistantText: "still generating",
      latestAssistantTruncated: false,
      revision: 2,
      timestamp: firstSubmission.timestamp + 1,
    };
    terminalSnapshotAvailable = true;
    await runtime.spawnAgents([{ agent_id: "new-run", prompt: "new run" }], 1, "reconcile-snapshot-trigger");

    expect(snapshotReads).toBeGreaterThan(1);
    expect(directReads).toBe(0);
    const view = await runtime.collectAgents(first.run_id);
    expect(view.results).toMatchObject([
      { agent_id: "active", result: { type: "text", text: "Reconciled answer" } },
    ]);
    expect(view.pending).toMatchObject([{ agent_id: "queued", state: "GENERATING" }]);
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

  it("preserves lifecycle completion queued while reconciliation observes a missing tab", async () => {
    let lifecycleListener: ((event: BrowserLifecycleEvent) => void) | undefined;
    const deferListTabs = true;
    let listTabsDeferred = false;
    let resolveListTabs: ((value: unknown) => void) | undefined;
    let openCalls = 0;
    const liveTabs = new Set<number>();
    const submitted = new Map<number, string>();
    const cached = { snapshot: undefined as ChatGptWorkerSnapshot | undefined };
    const browser = {
      subscribeLifecycle: (listener: (event: BrowserLifecycleEvent) => void) => {
        lifecycleListener = listener;
        return () => {
          if (lifecycleListener === listener) lifecycleListener = undefined;
        };
      },
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          liveTabs.add(openCalls);
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "list_tabs") {
          if (deferListTabs && !listTabsDeferred) {
            listTabsDeferred = true;
            return new Promise((resolve) => {
              resolveListTabs = resolve;
            });
          }
          return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: prompt,
            latestUserTruncated: false,
            latestAssistantText: "still generating",
            latestAssistantTruncated: false,
          });
        }
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => cached.snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
      observeWorkerTabs: async () => {
        const response = await browser.request("list_tabs");
        const tabs = (response as { tabs: Array<{ tabId: number }> }).tabs;
        return {
          tabIds: new Set(tabs.map((tab) => tab.tabId)),
          snapshots: new Map<number, ChatGptWorkerSnapshot>(),
        };
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-queued-completion",
    );
    const prompt = submitted.get(1);
    if (!prompt) throw new Error("expected first submitted prompt");
    const collecting = runtime.collectAgents(spawned.run_id);
    await flushUntil(() => listTabsDeferred, "reconciliation did not start its tab observation");

    const snapshot = {
      ready: true,
      generating: false,
      latestUserText: prompt,
      latestUserTruncated: false,
      latestAssistantText: `verified answer\n${completionMarker(prompt)}`,
      latestAssistantTruncated: false,
      revision: 2,
      timestamp: Date.now() + 1_000,
    } satisfies ChatGptWorkerSnapshot;
    cached.snapshot = snapshot;
    lifecycleListener?.({ type: "chatgpt_worker_snapshot", tabId: 1, snapshot });
    liveTabs.delete(1);

    await flushUntil(() => openCalls === 2, "queued work was not dispatched while reconciliation was pending");
    resolveListTabs?.({ tabs: [] });

    await collecting;
    const view = await runtime.collectAgents(spawned.run_id);

    expect(view.results).toMatchObject([
      { agent_id: "active", result: { text: "verified answer" } },
    ]);
    expect(view.failed).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "active" }),
    ]));
  });

  it("preserves removal completion evidence queued after reconciliation observes a missing tab", async () => {
    let lifecycleListener: ((event: BrowserLifecycleEvent) => void) | undefined;
    let observationStarted = false;
    let resolveObservation: ((value: unknown) => void) | undefined;
    let resolveRepairInspection: (() => void) | undefined;
    const repairInspection = new Promise<void>((resolve) => {
      resolveRepairInspection = resolve;
    });
    let openCalls = 0;
    const liveTabs = new Set<number>();
    const submitted = new Map<number, string>();
    const cached = { snapshot: undefined as ChatGptWorkerSnapshot | undefined };
    const browser = {
      subscribeLifecycle: (listener: (event: BrowserLifecycleEvent) => void) => {
        lifecycleListener = listener;
        return () => {
          if (lifecycleListener === listener) lifecycleListener = undefined;
        };
      },
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          liveTabs.add(openCalls);
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
            latestAssistantText: "still generating",
            latestAssistantTruncated: false,
          });
        }
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => cached.snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
      observeWorkerTabs: () => {
        observationStarted = true;
        return new Promise((resolve) => {
          resolveObservation = resolve;
        });
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-removal-completion",
    );
    const prompt = submitted.get(1);
    if (!prompt) throw new Error("expected first submitted prompt");
    const collecting = runtime.collectAgents(spawned.run_id);
    await flushUntil(() => observationStarted, "reconciliation did not start its tab observation");

    const snapshot = {
      ready: true,
      generating: false,
      latestUserText: prompt,
      latestUserTruncated: false,
      latestAssistantText: `verified answer\n${completionMarker(prompt)}`,
      latestAssistantTruncated: false,
      revision: 2,
      timestamp: Date.now() + 1_000,
    } satisfies ChatGptWorkerSnapshot;
    const observation = {
      get tabIds() {
        resolveRepairInspection?.();
        return new Set<number>();
      },
      snapshots: new Map<number, ChatGptWorkerSnapshot>(),
    };
    resolveObservation?.(observation);
    await repairInspection;

    cached.snapshot = snapshot;
    lifecycleListener?.({ type: "chatgpt_worker_snapshot", tabId: 1, snapshot });
    liveTabs.delete(1);
    cached.snapshot = undefined;
    lifecycleListener?.({ type: "agent_worker_tab_removed", tabId: 1, snapshot });

    await flushUntil(() => openCalls === 2, "queued work was not dispatched after removal completion was preserved");
    await collecting;
    const view = await runtime.collectAgents(spawned.run_id);

    expect(view.results).toMatchObject([
      { agent_id: "active", result: { text: "verified answer" } },
    ]);
    expect(view.failed).toEqual([]);
  });

  it("reports a missing worker as WORKER_TAB_CLOSED when collection races reconciliation", async () => {
    const deferListTabs = true;
    let listTabsDeferred = false;
    let resolveListTabs: ((value: unknown) => void) | undefined;
    let openCalls = 0;
    const liveTabs = new Set<number>();
    const submitted = new Map<number, string>();
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          liveTabs.add(openCalls);
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "list_tabs") {
          if (deferListTabs && !listTabsDeferred) {
            listTabsDeferred = true;
            return new Promise((resolve) => {
              resolveListTabs = resolve;
            });
          }
          return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
        }
        if (method === "read_chatgpt_worker_snapshot" || method === "read_chatgpt_worker") {
          return Promise.reject(new Error("TAB_NOT_FOUND: worker tab closed"));
        }
        if (method === "close_tab") {
          liveTabs.delete(args.tabId as number);
          return Promise.resolve({ closed: true });
        }
        return Promise.resolve({});
      },
      observeWorkerTabs: async () => {
        const response = await browser.request("list_tabs");
        const tabs = (response as { tabs: Array<{ tabId: number }> }).tabs;
        return {
          tabIds: new Set(tabs.map((tab) => tab.tabId)),
          snapshots: new Map<number, ChatGptWorkerSnapshot>(),
        };
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "collection-reconciliation-race",
    );
    const collecting = runtime.collectAgents(spawned.run_id);
    await flushUntil(() => listTabsDeferred, "reconciliation did not start its tab observation");

    const view = await collecting;

    expect(view.failed).toMatchObject([
      {
        agent_id: "active",
        state: "FAILED_TERMINAL",
        error: { code: "WORKER_TAB_CLOSED", retryable: false },
      },
    ]);
    await flushUntil(() => openCalls === 2, "queued work was not dispatched after the missing worker was observed");
    resolveListTabs?.({ tabs: [] });
  });

  it("does not accept an older reconciliation snapshot after newer generating evidence is cached", async () => {
    let deferSnapshotRead = false;
    let snapshotReadStarted = false;
    let resolveSnapshotRead: ((value: unknown) => void) | undefined;
    let openCalls = 0;
    const liveTabs = new Set<number>();
    const submitted = new Map<number, { prompt: string; timestamp: number }>();
    const cached = { snapshot: undefined as ChatGptWorkerSnapshot | undefined };
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") {
          openCalls += 1;
          liveTabs.add(openCalls);
          return Promise.resolve({ tab: { tabId: openCalls } });
        }
        if (method === "chatgpt_worker_submit") {
          const timestamp = Date.now();
          submitted.set(args.tabId as number, { prompt: args.prompt as string, timestamp });
          return Promise.resolve({ submitted: true, snapshot: { revision: 1, timestamp } });
        }
        if (method === "list_tabs") {
          return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
        }
        if (method === "read_chatgpt_worker_snapshot") {
          if (deferSnapshotRead && !snapshotReadStarted) {
            snapshotReadStarted = true;
            return new Promise((resolve) => {
              resolveSnapshotRead = resolve;
            });
          }
          return Promise.resolve({});
        }
        if (method === "read_chatgpt_worker") {
          const current = submitted.get(args.tabId as number);
          if (!current) throw new Error("missing submitted prompt");
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: current.prompt,
            latestUserTruncated: false,
            latestAssistantText: "still generating",
            latestAssistantTruncated: false,
          });
        }
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => cached.snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
      observeWorkerTabs: async () => {
        const response = await browser.request("list_tabs");
        const tabs = (response as { tabs: Array<{ tabId: number }> }).tabs;
        const tabIds = new Set(tabs.map((tab) => tab.tabId));
        const snapshots = new Map<number, ChatGptWorkerSnapshot>();
        for (const tabId of tabIds) {
          const snapshotResponse = await browser.request("read_chatgpt_worker_snapshot", {
            tabId,
            afterRevision: 0,
          });
          const snapshot = (snapshotResponse as { snapshot?: ChatGptWorkerSnapshot }).snapshot;
          if (snapshot) snapshots.set(tabId, snapshot);
        }
        return { tabIds, snapshots };
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "reconcile-stale-response",
    );
    const submission = submitted.get(1);
    if (!submission) throw new Error("expected first submitted prompt");
    deferSnapshotRead = true;

    const collecting = runtime.collectAgents(spawned.run_id);
    await flushUntil(() => snapshotReadStarted, "reconciliation did not start its snapshot observation");

    cached.snapshot = {
      ready: true,
      generating: true,
      latestUserText: submission.prompt,
      latestUserTruncated: false,
      latestAssistantText: "newer generation",
      latestAssistantTruncated: false,
      revision: 3,
      timestamp: submission.timestamp + 2,
    };
    resolveSnapshotRead?.({
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: submission.prompt,
        latestUserTruncated: false,
        latestAssistantText: `older terminal\n${completionMarker(submission.prompt)}`,
        latestAssistantTruncated: false,
        revision: 2,
        timestamp: submission.timestamp + 1,
      } satisfies ChatGptWorkerSnapshot,
    });

    await collecting;
    expect(openCalls).toBe(1);
    const view = await runtime.collectAgents(spawned.run_id);

    expect(view.results).toEqual([]);
    expect(view.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "active" }),
    ]));
  });

});
