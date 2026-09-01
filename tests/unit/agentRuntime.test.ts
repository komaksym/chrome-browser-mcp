import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

/** Creates a manually-resolved async boundary for deterministic race tests. */
function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** Extracts the unique protocol marker from a submitted worker prompt. */
function completionMarker(prompt: string): string {
  const marker = prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${prompt}`);
  return marker;
}

describe("AgentRuntime", () => {
  it("serializes overlapping collections so one queued job is never dispatched twice", async () => {
    const submitted = new Map<number, string>();
    const queuedTabOpens: Array<Deferred<{ tab: { tabId: number } }>> = [];
    const secondTabOpening = deferred<void>();
    let tabOpenCalls = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") {
          tabOpenCalls += 1;
          if (tabOpenCalls === 1) return Promise.resolve({ tab: { tabId: 1 } });
          const opening = deferred<{ tab: { tabId: number } }>();
          queuedTabOpens.push(opening);
          if (tabOpenCalls === 2) secondTabOpening.resolve();
          return opening.promise;
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const tabId = args.tabId as number;
          const prompt = submitted.get(tabId);
          if (!prompt) throw new Error(`No prompt submitted for tab ${tabId}`);
          if (tabId === 1) {
            return Promise.resolve({
              ready: true,
              generating: false,
              latestUserText: prompt,
              latestAssistantText: `First result\n${completionMarker(prompt)}`,
              latestAssistantTruncated: false,
            });
          }
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: prompt,
            latestAssistantText: null,
            latestAssistantTruncated: false,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "finish immediately" },
        { agent_id: "second", prompt: "remain queued" },
      ],
      1,
    );

    const firstCollection = runtime.collectAgents(spawned.run_id);
    await secondTabOpening.promise;
    const secondCollection = runtime.collectAgents(spawned.run_id);

    try {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      expect(tabOpenCalls).toBe(2);
    } finally {
      queuedTabOpens.forEach((opening, index) => opening.resolve({ tab: { tabId: index + 2 } }));
      await Promise.allSettled([firstCollection, secondCollection]);
    }
  });

  it("keeps a cancelled worker cancelled when collection completes concurrently", async () => {
    const readStarted = deferred<void>();
    const readResult = deferred<{
      ready: boolean;
      generating: boolean;
      latestUserText: string;
      latestAssistantText: string;
      latestAssistantTruncated: boolean;
    }>();
    let submittedPrompt = "";
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          readStarted.resolve();
          return readResult.promise;
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "cancel-me", prompt: "wait" }], 1);

    const collection = runtime.collectAgents(spawned.run_id);
    await readStarted.promise;
    const cancellation = runtime.cancelAgents(spawned.run_id);
    readResult.resolve({
      ready: true,
      generating: false,
      latestUserText: submittedPrompt,
      latestAssistantText: `Late result\n${completionMarker(submittedPrompt)}`,
      latestAssistantTruncated: false,
    });

    const [collected, cancelled] = await Promise.all([collection, cancellation]);
    expect(collected).toMatchObject({ state: "CANCELLED", barrier: { satisfied: false }, results: [] });
    expect(cancelled).toMatchObject({ jobs: [{ agent_id: "cancel-me", state: "CANCELLED" }] });
  });

  it("marks verified worker output untrusted and caps it before returning it", async () => {
    let submittedPrompt = "";
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: `${"x".repeat(40_000)}\n${completionMarker(submittedPrompt)}`,
            latestAssistantTruncated: false,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "untrusted", prompt: "answer" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);
    const result = collected.results[0]?.result;

    expect(result).toMatchObject({
      type: "text",
      contentIsUntrusted: true,
      truncated: true,
    });
    expect(result?.warning).toContain("untrusted");
    expect(result?.text.length).toBeLessThanOrEqual(30_000);
  });

  it("lets cancellation close a verified worker tab without changing its result", async () => {
    let submittedPrompt = "";
    const closeCalls: number[] = [];
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: `Completed result\n${completionMarker(submittedPrompt)}`,
            latestAssistantTruncated: false,
          });
        }
        if (method === "close_tab") {
          closeCalls.push(args.tabId as number);
          return Promise.resolve({ closed: true });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "complete", prompt: "finish" }], 1);

    await runtime.collectAgents(spawned.run_id);
    const cancelled = await runtime.cancelAgents(spawned.run_id);

    expect(cancelled).toMatchObject({ jobs: [{ agent_id: "complete", state: "VERIFIED_DONE" }] });
    expect(closeCalls).toEqual([1]);
    expect(runtime.isWorkerTab(1)).toBe(false);
  });

  it("keeps typed browser transport timeouts retryable", async () => {
    const browser = {
      request: () => Promise.reject(new BrowserError("TIMEOUT", "browser request timed out")),
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);

    const spawned = await runtime.spawnAgents([{ agent_id: "retry", prompt: "retry after transport timeout" }], 1);

    expect(spawned).toMatchObject({
      state: "RUNNING",
      jobs: [{
        agent_id: "retry",
        state: "FAILED_TRANSIENT",
        error: { code: "TIMEOUT", retryable: true },
      }],
    });
  });

  it("recovers a later read of the same finished turn with exactly one submission", async () => {
    let submittedPrompt = "";
    let submissions = 0;
    let reads = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submissions += 1;
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          reads += 1;
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText:
              reads === 1 ? "Finished but first observation missed marker" : `Recovered result\n${completionMarker(submittedPrompt)}`,
            latestAssistantTruncated: false,
            tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
          });
        }
        if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
        if (method === "activate_worker_tab") return Promise.resolve({});
        if (method === "reload_worker_tab") return Promise.resolve({});
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "recover", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissions).toBe(1);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "recover", result: { text: "Recovered result" } }],
    });
  });

  it("activates a background worker to recover without another submission and restores the prior tab", async () => {
    let submittedPrompt = "";
    let submissions = 0;
    let reads = 0;
    const activations: number[] = [];
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submissions += 1;
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          reads += 1;
          const recovered = reads >= 5;
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: recovered ? `Activated result\n${completionMarker(submittedPrompt)}` : "marker unavailable in background",
            latestAssistantTruncated: false,
            tab: { tabId: 1, windowId: 10, active: recovered, discarded: false, status: "complete" },
          });
        }
        if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
        if (method === "activate_worker_tab") {
          activations.push(args.tabId as number);
          return Promise.resolve({});
        }
        if (method === "reload_worker_tab") throw new Error("reload should not be needed");
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "activate", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissions).toBe(1);
    expect(activations).toEqual([1, 99]);
    expect(collected.state).toBe("COMPLETE");
  });

  it("reloads only a definitely finished worker and recovers without resubmission", async () => {
    let submittedPrompt = "";
    let submissions = 0;
    let reads = 0;
    let reloads = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submissions += 1;
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          reads += 1;
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText:
              reloads > 0 ? `Reloaded result\n${completionMarker(submittedPrompt)}` : "finished marker not visible",
            latestAssistantTruncated: false,
            tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
          });
        }
        if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
        if (method === "activate_worker_tab") return Promise.resolve({});
        if (method === "reload_worker_tab") {
          reloads += 1;
          return Promise.resolve({});
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "reload", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissions).toBe(1);
    expect(reloads).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect(collected.state).toBe("COMPLETE");
  });

  it("surfaces recovery exhaustion explicitly without regeneration", async () => {
    let submittedPrompt = "";
    let submissions = 0;
    let reloads = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submissions += 1;
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: "finished marker never observable",
            latestAssistantTruncated: false,
            tab: { tabId: 1, windowId: 10, active: false, discarded: true, status: "complete" },
          });
        }
        if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
        if (method === "activate_worker_tab") return Promise.resolve({});
        if (method === "reload_worker_tab") {
          reloads += 1;
          return Promise.resolve({});
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "exhaust", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissions).toBe(1);
    expect(reloads).toBe(1);
    expect(collected).toMatchObject({
      state: "FAILED",
      failed: [{
        agent_id: "exhaust",
        state: "FAILED_TERMINAL",
        error: { code: "RECOVERY_EXHAUSTED", retryable: false },
        diagnostics: {
          uncertainty_reason: expect.stringContaining("completion marker"),
          recovery_steps: ["current_state", "bounded_reread", "activate_worker_tab", "reload_worker_tab"],
          tab: { active: false, discarded: true, status: "complete" },
        },
      }],
    });
  });

  it("does not reload while the worker is still generating", async () => {
    let submittedPrompt = "";
    let reloads = 0;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: submittedPrompt,
            latestAssistantText: "partial",
            latestAssistantTruncated: false,
          });
        }
        if (method === "reload_worker_tab") {
          reloads += 1;
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "generating", prompt: "keep going" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(reloads).toBe(0);
    expect(collected.pending).toMatchObject([{ agent_id: "generating", state: "GENERATING" }]);
  });

});
