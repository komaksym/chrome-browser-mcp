import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";
import { withAgentAnchor } from "../agentBrowserFixture.js";
import { createRecoveryBrowser } from "./recoveryBrowserFixture.js";

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
 request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
 if (method === "open_agent_worker_tab") {
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
 }),
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
 request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
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
 }),
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
 request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
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
 }),
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
 request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
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
 }),
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
 request: withAgentAnchor(() =>
      Promise.reject(new BrowserError("TIMEOUT", "browser request timed out"))),
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
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText:
 current.reads === 1
 ? "Finished but first observation missed marker"
 : `Recovered result\n${completionMarker(current.submittedPrompt)}`,
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
 }),
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "recover", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(collected).toMatchObject({
 state: "COMPLETE",
 results: [{
 agent_id: "recover",
 result: { text: "Recovered result" },
 diagnostics: {
 observation_source: "backoff_reread",
 recovery_steps: ["current_state", "bounded_reread"],
 uncertainty_reason: "completion marker missing after generation appeared finished",
 },
 }],
 });
 });

 it("activates a background worker to recover without another submission and restores the prior tab", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => {
 const recovered = current.reads >= 5;
 return Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText: recovered
 ? `Activated result\n${completionMarker(current.submittedPrompt)}`
 : "marker unavailable in background",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: recovered, discarded: false, status: "complete" },
 });
 },
 reload: () => {
 throw new Error("reload should not be needed");
 },
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "activate", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.activations).toEqual([1, 99]);
 expect(collected.state).toBe("COMPLETE");
 });

 it("reloads only a definitely finished worker and recovers without resubmission", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText:
 current.reloads > 0
 ? `Reloaded result\n${completionMarker(current.submittedPrompt)}`
 : "finished marker not visible",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
 }),
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "reload", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.reloads).toBe(1);
 expect(state.reads).toBeGreaterThan(1);
 expect(collected.state).toBe("COMPLETE");
 });

 it("surfaces recovery exhaustion explicitly without regeneration", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText: "finished marker never observable",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: true, status: "complete" },
 }),
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "exhaust", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.reloads).toBe(1);
 expect(collected).toMatchObject({
 state: "FAILED",
 failed: [{
 agent_id: "exhaust",
 state: "FAILED_TERMINAL",
 error: { code: "RECOVERY_EXHAUSTED", retryable: false },
 diagnostics: {
 uncertainty_reason: "completion marker missing after generation appeared finished",
 recovery_steps: ["current_state", "bounded_reread", "activate_worker_tab", "reload_worker_tab"],
 tab: { active: false, discarded: true, status: "complete" },
 },
 }],
 });
 });

 it("does not reload while the worker is still generating", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: true,
 latestUserText: current.submittedPrompt,
 latestAssistantText: "partial",
 latestAssistantTruncated: false,
 }),
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "generating", prompt: "keep going" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.reloads).toBe(0);
 expect(collected.pending).toMatchObject([{ agent_id: "generating", state: "GENERATING" }]);
 });

 it("preserves finished evidence without reloading after newer generating observations", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => {
 if (current.reads === 1) {
 return Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText: "finished marker not visible",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
 });
 }
 return Promise.resolve({
 ready: true,
 generating: true,
 latestUserText: current.submittedPrompt,
 latestAssistantText: null,
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "loading" },
 });
 },
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "monotonic", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.reloads).toBe(0);
 expect(collected).toMatchObject({
 state: "FAILED",
 failed: [{
 agent_id: "monotonic",
 error: { code: "RECOVERY_EXHAUSTED" },
 diagnostics: {
 observation_state: { generating: true },
 recovery_steps: ["current_state", "bounded_reread", "activate_worker_tab"],
 },
 }],
 });
 });

 it("does not mask worker identity mismatch as recovery exhaustion", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.reads === 1 ? current.submittedPrompt : "different worker turn",
 latestAssistantText: "finished marker never observable",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
 }),
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "identity", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.reloads).toBe(0);
 expect(collected).toMatchObject({
 state: "FAILED",
 failed: [{
 agent_id: "identity",
 error: { code: "WORKER_IDENTITY_MISMATCH", retryable: false },
 }],
 });
 });

 it("continues recovery after activation failure and surfaces recovery exhaustion", async () => {
 const { browser, state } = createRecoveryBrowser({
 read: (current) => Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: current.submittedPrompt,
 latestAssistantText: "finished marker never observable",
 latestAssistantTruncated: false,
 tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
 }),
 activate: (tabId) => {
 if (tabId === 1) throw new Error("ACTIVATION_FAILED: worker activation failed");
 return Promise.resolve({});
 },
 });
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "activation-error", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(state.submissions).toBe(1);
 expect(state.reloads).toBe(1);
 expect(collected).toMatchObject({
 state: "FAILED",
 failed: [{
 agent_id: "activation-error",
 state: "FAILED_TERMINAL",
 error: { code: "RECOVERY_EXHAUSTED", retryable: false },
 diagnostics: {
 recovery_steps: ["current_state", "bounded_reread", "activate_worker_tab", "reload_worker_tab"],
 },
 }],
 });
 });

  it("dispatches queued workers through the stored parent identity", async () => {
    const anchorIds: number[] = [];
    const submitted = new Map<number, string>();
    const browser = {
      request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
        if (method === "open_agent_worker_tab") {
          anchorIds.push(args.anchorTabId as number);
          return Promise.resolve({ tab: { tabId: anchorIds.length } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const tabId = args.tabId as number;
          const prompt = submitted.get(tabId)!;
          return Promise.resolve(tabId === 1
            ? { ready: true, generating: false, latestUserText: prompt, latestAssistantText: `done\n${completionMarker(prompt)}` }
            : { ready: true, generating: true, latestUserText: prompt, latestAssistantText: null });
        }
        return Promise.resolve({});
      }, { tabId: 42, windowId: 1 }),
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "one", prompt: "one" }, { agent_id: "two", prompt: "two" }], 1);
    await runtime.collectAgents(spawned.run_id);
    expect(anchorIds).toEqual([42, 42]);
  });

  it("fails queued work when the stored parent becomes unavailable", async () => {
    let opened = 0;
    let submittedPrompt = "";
    const browser = {
      request: withAgentAnchor((method: string, args: Record<string, unknown> = {}) => {
        if (method === "open_agent_worker_tab") {
          opened += 1;
          if (opened > 1) {
            return Promise.reject(new BrowserError("AGENT_ANCHOR_UNAVAILABLE", "Parent ChatGPT tab is unavailable"));
          }
          expect(args.anchorTabId).toBe(42);
          return Promise.resolve({ tab: { tabId: opened } });
        }
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") return Promise.resolve({
          ready: true, generating: false, latestUserText: submittedPrompt,
          latestAssistantText: `done\n${completionMarker(submittedPrompt)}`,
        });
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      }, { tabId: 42, windowId: 1 }),
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "one", prompt: "one" }, { agent_id: "two", prompt: "two" }], 1);
    const collected = await runtime.collectAgents(spawned.run_id);
    expect(opened).toBe(2);
    expect(collected.failed).toMatchObject([{ agent_id: "two", error: { code: "AGENT_ANCHOR_UNAVAILABLE", retryable: false } }]);
  });


});
