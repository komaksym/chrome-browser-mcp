import { expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import type { BrowserClient } from "../../src/bridge/browserClient.js";

type RecoveryReadResult = {
  ready: boolean;
  generating: boolean;
  latestUserText: string;
  latestAssistantText: string;
  latestAssistantTruncated: boolean;
  tab: { tabId: number; windowId: number; active: boolean; discarded: boolean; status: string };
};

it("keeps cancellation authoritative when a recovery read finishes late", async () => {
  let resolveRecoveryReadStarted!: () => void;
  const recoveryReadStarted = new Promise<void>((resolve) => {
    resolveRecoveryReadStarted = resolve;
  });

  let resolveRecoveryRead!: (value: RecoveryReadResult) => void;
  const recoveryReadResult = new Promise<RecoveryReadResult>((resolve) => {
    resolveRecoveryRead = resolve;
  });

  let submittedPrompt = "";
  let submissions = 0;
  let reads = 0;

  const browser = {
    request: (method: string, args: Record<string, unknown> = {}) => {
      if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
      if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
      if (method === "chatgpt_worker_submit") {
        submissions += 1;
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
        resolveRecoveryReadStarted();
        return recoveryReadResult;
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
  await recoveryReadStarted;
  const cancellation = runtime.cancelAgents(spawned.run_id);

  const marker = submittedPrompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${submittedPrompt}`);
  resolveRecoveryRead({
    ready: true,
    generating: false,
    latestUserText: submittedPrompt,
    latestAssistantText: `Late recovered result\n${marker}`,
    latestAssistantTruncated: false,
    tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
  });

  const [collected, cancelled] = await Promise.all([collection, cancellation]);

  expect(submissions).toBe(1);
  expect(collected).toMatchObject({ state: "CANCELLED", barrier: { satisfied: false }, results: [] });
  expect(cancelled).toMatchObject({ jobs: [{ agent_id: "cancel-recovery", state: "CANCELLED" }] });
});
