import { expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import type { BrowserClient } from "../../src/bridge/browserClient.js";

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

it("keeps cancellation authoritative when a recovery read finishes late", async () => {
  const recoveryReadStarted = deferred<void>();
  const recoveryReadResult = deferred<{
    ready: boolean;
    generating: boolean;
    latestUserText: string;
    latestAssistantText: string;
    latestAssistantTruncated: boolean;
    tab: { tabId: number; windowId: number; active: boolean; discarded: boolean; status: string };
  }>();
  let submittedPrompt = "";
  let reads = 0;

  const browser = {
    request: (method: string, args: Record<string, unknown> = {}) => {
      if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
      if (method === "chatgpt_worker_submit") {
        submittedPrompt = args.prompt as string;
        return Promise.resolve({ submitted: true });
      }
      if (method === "read_chatgpt_worker") {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: "finished marker missing",
            latestAssistantTruncated: false,
            tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
          });
        }
        recoveryReadStarted.resolve();
        return recoveryReadResult.promise;
      }
      if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
      if (method === "activate_worker_tab") return Promise.resolve({});
      if (method === "reload_worker_tab") return Promise.resolve({});
      if (method === "close_tab") return Promise.resolve({ closed: true });
      return Promise.resolve({});
    },
  } as BrowserClient;

  const runtime = new AgentRuntime(browser);
  const spawned = await runtime.spawnAgents([{ agent_id: "cancel-recovery", prompt: "answer once" }], 1);

  const collection = runtime.collectAgents(spawned.run_id);
  await recoveryReadStarted.promise;
  const cancellation = runtime.cancelAgents(spawned.run_id);

  recoveryReadResult.resolve({
    ready: true,
    generating: false,
    latestUserText: submittedPrompt,
    latestAssistantText: `Late recovered result\n${completionMarker(submittedPrompt)}`,
    latestAssistantTruncated: false,
    tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
  });

  const [collected, cancelled] = await Promise.all([collection, cancellation]);

  expect(collected).toMatchObject({ state: "CANCELLED", barrier: { satisfied: false }, results: [] });
  expect(cancelled).toMatchObject({ jobs: [{ agent_id: "cancel-recovery", state: "CANCELLED" }] });
});
