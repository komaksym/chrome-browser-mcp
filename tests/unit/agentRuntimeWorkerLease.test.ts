import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";

function completionMarker(prompt: string): string {
  const marker = prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${prompt}`);
  return marker;
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
});
