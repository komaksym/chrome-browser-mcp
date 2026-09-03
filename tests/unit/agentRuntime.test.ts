import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";
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
 it("deduplicates concurrent spawn requests with the same request identity", async () => {
 const anchorReady = deferred<{ tab: { tabId: number; windowId: number } }>();
 let initialAnchorCalls = 0;
 let anchoredCalls = 0;
 let tabOpenCalls = 0;
 let submissionCalls = 0;
 const browser = {
 request: (method: string, args: Record<string, unknown> = {}) => {
 if (method === "resolve_chatgpt_anchor") {
 if ("excludedTabIds" in args) {
 initialAnchorCalls += 1;
 return anchorReady.promise;
 }
 anchoredCalls += 1;
 return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 }
 if (method === "open_agent_worker_tab") {
 tabOpenCalls += 1;
 return Promise.resolve({ tab: { tabId: 100 + tabOpenCalls } });
 }
 if (method === "chatgpt_worker_submit") {
 submissionCalls += 1;
 return Promise.resolve({ submitted: true });
 }
 return Promise.resolve({});
 },
 } as BrowserClient;
 const runtime = new AgentRuntime(browser);
 const tasks = [{ agent_id: "same", prompt: "do this once" }];

 const first = runtime.spawnAgents(tasks, 1, "request-1");
 const second = runtime.spawnAgents(tasks, 1, "request-1");
 await Promise.resolve();
 expect(initialAnchorCalls).toBe(1);

 anchorReady.resolve({ tab: { tabId: 9000, windowId: 42 } });
 const [firstResult, secondResult] = await Promise.all([first, second]);

 expect(secondResult).toEqual(firstResult);
 expect(anchoredCalls).toBe(0);
 expect(tabOpenCalls).toBe(1);
 expect(submissionCalls).toBe(1);
 });

 it("rejects conflicting reuse of a request identity without starting another run", async () => {
 let tabOpenCalls = 0;
 let submissionCalls = 0;
 const browser = {
 request: (method: string) => {
 if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 if (method === "open_agent_worker_tab") {
 tabOpenCalls += 1;
 return Promise.resolve({ tab: { tabId: 100 + tabOpenCalls } });
 }
 if (method === "chatgpt_worker_submit") {
 submissionCalls += 1;
 return Promise.resolve({ submitted: true });
 }
 return Promise.resolve({});
 },
 } as BrowserClient;
 const runtime = new AgentRuntime(browser);

 await runtime.spawnAgents([{ agent_id: "same", prompt: "original" }], 1, "request-1");
 await expect(runtime.spawnAgents([{ agent_id: "same", prompt: "changed" }], 1, "request-1"))
 .rejects.toThrow("IDEMPOTENCY_CONFLICT");

 expect(tabOpenCalls).toBe(1);
 expect(submissionCalls).toBe(1);
 });

 it("keeps logical jobs queued when the global active-worker ceiling is full", async () => {
 const submitted = new Map<number, string>();
 const activeTabs = new Set<number>();
 let maxActiveTabs = 0;
 let nextTabId = 1;
 const browser = {
 request: (method: string, args: Record<string, unknown> = {}) => {
 if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: nextTabId++ } });
 if (method === "chatgpt_worker_submit") {
 const tabId = args.tabId as number;
 submitted.set(tabId, args.prompt as string);
 activeTabs.add(tabId);
 maxActiveTabs = Math.max(maxActiveTabs, activeTabs.size);
 return Promise.resolve({ submitted: true });
 }
 if (method === "read_chatgpt_worker") {
 const tabId = args.tabId as number;
 const prompt = submitted.get(tabId);
 if (!prompt) throw new Error(`No prompt submitted for tab ${tabId}`);
 activeTabs.delete(tabId);
 return Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: prompt,
 latestAssistantText: `Done\n${completionMarker(prompt)}`,
 });
 }
 return Promise.resolve({});
 },
 } as BrowserClient;
 const runtime = new AgentRuntime(browser);

 const first = await runtime.spawnAgents(
 [
 { agent_id: "first-a", prompt: "first a" },
 { agent_id: "first-b", prompt: "first b" },
 ],
 2,
 "run-1",
 );
 const second = await runtime.spawnAgents(
 [
 { agent_id: "second-a", prompt: "second a" },
 { agent_id: "second-b", prompt: "second b" },
 ],
 2,
 "run-2",
 );

 expect(first.jobs).toHaveLength(2);
 expect(first.jobs.every((job) => job.state === "DISPATCHED")).toBe(true);
 expect(second.jobs.every((job) => job.state === "CREATED")).toBe(true);
 expect(maxActiveTabs).toBe(2);

 const firstCollected = await runtime.collectAgents(first.run_id);
 expect(firstCollected.state).toBe("COMPLETE");
 expect(maxActiveTabs).toBe(2);

 const secondCollected = await runtime.collectAgents(second.run_id);
 expect(secondCollected.state).toBe("COMPLETE");
 });

 it("serializes overlapping collections so one queued job is never dispatched twice", async () => {
 const submitted = new Map<number, string>();
 const queuedTabOpens: Array<Deferred<{ tab: { tabId: number } }>> = [];
 const secondTabOpening = deferred<void>();
 let tabOpenCalls = 0;
 const browser = {
 request: (method: string, args: Record<string, unknown> = {}) => {
      if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
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
      if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
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
      if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
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
      if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
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
 request: (method: string) => {
 if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 return Promise.reject(new BrowserError("TIMEOUT", "browser request timed out"));
 },
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

 it("accepts a rendered worker user turn when its unique protocol marker still matches", async () => {
 let submittedPrompt = "";
 const browser = {
 request: (method: string, args: Record<string, unknown> = {}) => {
 if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
 if (method === "chatgpt_worker_submit") {
 submittedPrompt = args.prompt as string;
 return Promise.resolve({ submitted: true });
 }
 if (method === "read_chatgpt_worker") {
 const marker = completionMarker(submittedPrompt);
 return Promise.resolve({
 ready: true,
 generating: false,
 latestUserText: `Rendered worker turn\n${marker}`,
 latestUserTruncated: false,
 latestAssistantText: `Rendered result\n${marker}`,
 latestAssistantTruncated: false,
 });
 }
 if (method === "close_tab") return Promise.resolve({ closed: true });
 return Promise.resolve({});
 },
 } as unknown as BrowserClient;
 const runtime = new AgentRuntime(browser);
 const spawned = await runtime.spawnAgents([{ agent_id: "rendered", prompt: "answer once" }], 1);

 const collected = await runtime.collectAgents(spawned.run_id);

 expect(collected).toMatchObject({
 state: "COMPLETE",
 barrier: { satisfied: true },
 results: [{ agent_id: "rendered", result: { type: "text", text: "Rendered result" } }],
 failed: [],
 pending: [],
 });
 });

 it("recognizes a rendered submitted turn after a lost acknowledgement without submitting twice", async () => {
 let submittedPrompt = "";
 let submissionCalls = 0;
 const browser = {
 request: (method: string, args: Record<string, unknown> = {}) => {
 if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
 if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
 if (method === "chatgpt_worker_submit") {
 submissionCalls += 1;
 submittedPrompt = args.prompt as string;
 if (submissionCalls === 1) {
 return Promise.reject(new BrowserError("TIMEOUT", "worker submit acknowledgement was lost"));
 }
 return Promise.resolve({ submitted: true });
 }
 if (method === "read_chatgpt_worker") {
 const marker = completionMarker(submittedPrompt);
 return Promise.resolve({
 ready: true,
 generating: true,
 latestUserText: `Rendered worker turn\n${marker}`,
 latestUserTruncated: false,
 latestAssistantText: null,
 latestAssistantTruncated: false,
 });
 }
 return Promise.resolve({});
 },
 } as unknown as BrowserClient;
 const runtime = new AgentRuntime(browser);

 const spawned = await runtime.spawnAgents([{ agent_id: "lost-ack", prompt: "answer once" }], 1);

 expect(spawned).toMatchObject({
 state: "RUNNING",
 jobs: [{ agent_id: "lost-ack", state: "DISPATCHED" }],
 });
 expect(submissionCalls).toBe(1);
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

  it("dispatches queued workers through the stored anchor identity", async () => {
    const openedAnchors: number[] = [];
    const submitted = new Map<number, string>();
    let nextTabId = 101;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 55, windowId: 3 } });
        }
        if (method === "open_agent_worker_tab") {
          openedAnchors.push(args.anchorTabId as number);
          return Promise.resolve({ tab: { tabId: nextTabId++ } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `Done\n${completionMarker(prompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "first" },
        { agent_id: "second", prompt: "second" },
      ],
      1,
    );
    expect(openedAnchors).toEqual([55]);

    await runtime.collectAgents(spawned.run_id);
    expect(openedAnchors).toEqual([55, 55]);
  });

  it("fails queued work with ANCHOR_UNAVAILABLE instead of opening in an arbitrary window", async () => {
    let anchorAvailable = true;
    let openedTabs = 0;
    const submitted = new Map<number, string>();
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          return Promise.resolve({ tab: { tabId: 55, windowId: 3 } });
        }
        if (method === "open_agent_worker_tab") {
          if (!anchorAvailable) {
            return Promise.reject(new Error("ANCHOR_UNAVAILABLE: Parent ChatGPT tab is no longer available"));
          }
          openedTabs += 1;
          return Promise.resolve({ tab: { tabId: openedTabs } });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const prompt = submitted.get(args.tabId as number);
          if (!prompt) throw new Error("missing prompt");
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `Done\n${completionMarker(prompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);

    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "first", prompt: "first" },
        { agent_id: "second", prompt: "second" },
      ],
      1,
    );
    anchorAvailable = false;
    const collected = await runtime.collectAgents(spawned.run_id);
    const [failed] = collected.failed;

    expect(openedTabs).toBe(1);
    expect(failed?.agent_id).toBe("second");
    expect(failed?.state).toBe("FAILED_TERMINAL");
    expect(failed?.error?.code).toBe("ANCHOR_UNAVAILABLE");
    expect(failed?.error?.retryable).toBe(false);
  });

  it("excludes runtime-owned worker tabs when resolving the anchor for a new run", async () => {
    const anchorRequests: Record<string, unknown>[] = [];
    let nextTabId = 20;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") {
          anchorRequests.push(args);
          return Promise.resolve({ tab: { tabId: 7, windowId: 2 } });
        }
        if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: nextTabId++ } });
        if (method === "chatgpt_worker_submit") return Promise.resolve({ submitted: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);

    await runtime.spawnAgents([{ agent_id: "first", prompt: "first" }], 1);
    await runtime.spawnAgents([{ agent_id: "second", prompt: "second" }], 1);

    expect(anchorRequests[0]).toEqual({ excludedTabIds: [] });
    expect(anchorRequests[1]).toEqual({ excludedTabIds: [20] });
  });

  it("completes from a fresh streamed snapshot without rereading the virtualized DOM", async () => {
    let submittedPrompt = "";
    let submissionCalls = 0;
    let directReads = 0;
    let snapshot: Record<string, unknown> | undefined;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 801 } });
        if (method === "chatgpt_worker_submit") {
          submissionCalls += 1;
          submittedPrompt = args.prompt as string;
          snapshot = {
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestUserTruncated: false,
            latestAssistantText: `Snapshot answer\n${completionMarker(submittedPrompt)}`,
            latestAssistantTruncated: false,
            revision: 2,
            timestamp: Date.now() + 10,
          };
          return Promise.resolve({ submitted: true, snapshot: { revision: 1, timestamp: Date.now() } });
        }
        if (method === "read_chatgpt_worker") {
          directReads += 1;
          return Promise.reject(new Error("EXTRACTION_FAILED: assistant node was virtualized"));
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "snapshot", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissionCalls).toBe(1);
    expect(directReads).toBe(0);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "snapshot", result: { type: "text", text: "Snapshot answer", truncated: false } }],
    });
  });

  it("rejects stale or mismatched snapshots before falling back to a direct read", async () => {
    let submittedPrompt = "";
    let directReads = 0;
    let snapshot: Record<string, unknown> | undefined;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 802 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          snapshot = {
            ready: true,
            generating: false,
            latestUserText: "different worker turn",
            latestUserTruncated: false,
            latestAssistantText: `Wrong answer\n${completionMarker(submittedPrompt)}`,
            latestAssistantTruncated: false,
            revision: 2,
            timestamp: Date.now() + 10,
          };
          return Promise.resolve({ submitted: true, snapshot: { revision: 2, timestamp: Date.now() } });
        }
        if (method === "read_chatgpt_worker_snapshot") {
          return Promise.resolve({ snapshot: snapshot ? { ...snapshot, revision: 3 } : undefined });
        }
        if (method === "read_chatgpt_worker") {
          directReads += 1;
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: `Direct answer\n${completionMarker(submittedPrompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "identity", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(directReads).toBe(1);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "identity", result: { type: "text", text: "Direct answer" } }],
    });
  });

  it("does not leave a job pending for a fresh snapshot from another turn", async () => {
    let submittedPrompt = "";
    let directReads = 0;
    let snapshot: Record<string, unknown> | undefined;
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 803 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          snapshot = {
            ready: true,
            generating: true,
            latestUserText: "another worker turn",
            latestUserTruncated: false,
            latestAssistantText: null,
            latestAssistantTruncated: false,
            revision: 2,
            timestamp: Date.now() + 10,
          };
          return Promise.resolve({ submitted: true, snapshot: { revision: 1, timestamp: Date.now() } });
        }
        if (method === "read_chatgpt_worker") {
          directReads += 1;
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: `Direct answer\n${completionMarker(submittedPrompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
      latestChatGptWorkerSnapshot: () => snapshot,
      forgetChatGptWorkerSnapshot: () => undefined,
    } as unknown as BrowserClient;
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "partial-identity", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(directReads).toBe(1);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      results: [{ agent_id: "partial-identity", result: { type: "text", text: "Direct answer" } }],
    });
  });

});
