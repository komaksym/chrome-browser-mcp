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

interface CleanupHarnessOptions {
  closeFails?: boolean;
}

function cleanupHarness(options: CleanupHarnessOptions = {}) {
  let lifecycleListener: ((event: BrowserLifecycleEvent) => void) | undefined;
  const submitted = new Map<number, string>();
  const liveTabs = new Set([7000, 9000]);
  const closeCalls: number[] = [];
  const activationCalls: number[] = [];
  let nextWorkerTabId = 1;

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
        const tabId = nextWorkerTabId++;
        liveTabs.add(tabId);
        return Promise.resolve({ tab: { tabId } });
      }
      if (method === "chatgpt_worker_submit") {
        submitted.set(args.tabId as number, args.prompt as string);
        return Promise.resolve({ submitted: true });
      }
      if (method === "read_chatgpt_worker_snapshot") return Promise.resolve({});
      if (method === "read_chatgpt_worker") {
        const prompt = submitted.get(args.tabId as number);
        if (!prompt) throw new Error("missing submitted prompt");
        return Promise.resolve({
          ready: true,
          generating: false,
          latestUserText: prompt,
          latestUserTruncated: false,
          latestAssistantText: `verified answer\n${completionMarker(prompt)}`,
          latestAssistantTruncated: false,
        });
      }
      if (method === "list_tabs") {
        return Promise.resolve({ tabs: [...liveTabs].map((tabId) => ({ tabId })) });
      }
      if (method === "close_tab") {
        const tabId = args.tabId as number;
        closeCalls.push(tabId);
        if (options.closeFails) {
          return Promise.reject(new BrowserError("ACTION_FAILED", "worker cleanup failed"));
        }
        liveTabs.delete(tabId);
        return Promise.resolve({ closed: true });
      }
      if (method === "activate_worker_tab") {
        activationCalls.push(args.tabId as number);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    latestChatGptWorkerSnapshot: () => undefined,
    forgetChatGptWorkerSnapshot: () => undefined,
  } as unknown as BrowserClient;

  return {
    browser,
    submitted,
    liveTabs,
    closeCalls,
    activationCalls,
    emit: (event: BrowserLifecycleEvent) => lifecycleListener?.(event),
  };
}

describe("AgentRuntime verified worker cleanup", () => {
  it("closes the exact worker tab after collection captures its verified result", async () => {
    const harness = cleanupHarness();
    const runtime = new AgentRuntime(harness.browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "worker", prompt: "finish" }], 1, "cleanup-collect");

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(collected).toMatchObject({
      state: "COMPLETE",
      barrier: { satisfied: true },
      results: [{
        agent_id: "worker",
        state: "VERIFIED_DONE",
        result: { type: "text", text: "verified answer" },
      }],
    });
    expect(harness.closeCalls).toEqual([1]);
    expect(harness.liveTabs).toEqual(new Set([7000, 9000]));
    expect(runtime.isWorkerTab(1)).toBe(false);

    const collectedAgain = await runtime.collectAgents(spawned.run_id);
    expect(collectedAgain.results).toEqual(collected.results);
    expect(harness.closeCalls).toEqual([1]);
  });

  it("closes a lifecycle-completed worker without activating it", async () => {
    const harness = cleanupHarness();
    const runtime = new AgentRuntime(harness.browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "worker", prompt: "finish" }], 1, "cleanup-event");
    const prompt = harness.submitted.get(1);
    if (!prompt) throw new Error("expected worker submission");

    harness.emit({
      type: "chatgpt_worker_snapshot",
      tabId: 1,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: prompt,
        latestUserTruncated: false,
        latestAssistantText: `event result\n${completionMarker(prompt)}`,
        latestAssistantTruncated: false,
        revision: 1,
        timestamp: Date.now() + 1_000,
      },
    });

    await flushUntil(() => harness.closeCalls.length === 1, "verified lifecycle completion did not close its worker tab");
    expect(harness.closeCalls).toEqual([1]);
    expect(harness.activationCalls).toEqual([]);
    expect(runtime.isWorkerTab(1)).toBe(false);

    const collected = await runtime.collectAgents(spawned.run_id);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "worker", state: "VERIFIED_DONE", result: { text: "event result" } }],
    });
  });

  it("keeps a verified result and worker ownership when physical cleanup fails", async () => {
    const harness = cleanupHarness({ closeFails: true });
    const runtime = new AgentRuntime(harness.browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "worker", prompt: "finish" }], 1, "cleanup-failure");

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "worker", state: "VERIFIED_DONE", result: { text: "verified answer" } }],
      failed: [],
      pending: [],
    });
    expect(harness.closeCalls).toEqual([1]);
    expect(harness.liveTabs.has(1)).toBe(true);
    expect(runtime.isWorkerTab(1)).toBe(true);
  });
});
