import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserClient } from "../../src/bridge/browserClient.js";
import { NativeMessageReader, writeNativeMessage } from "../../src/bridge/nativeMessaging.js";

describe("AgentRuntime with BrowserClient", () => {
  it("recovers a missed first response through observation-only rereads without resubmitting", async () => {
    const fromExtension = new PassThrough();
    const toExtension = new PassThrough();
    const browser = new BrowserClient(fromExtension, toExtension, 2_000);
    let submittedPrompt = "";
    let submissionCalls = 0;
    let directReads = 0;

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.11",
      extensionId: "test-extension",
    });

    new NativeMessageReader(
      toExtension,
      (message) => {
        const request = message as {
          type: string;
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        if (request.type !== "request") return;

        let result: unknown;
        switch (request.method) {
          case "resolve_chatgpt_anchor":
            result = { tab: { tabId: 9000, windowId: 10 } };
            break;
          case "open_agent_worker_tab":
            result = { tab: { tabId: 42 } };
            break;
          case "chatgpt_worker_submit":
            submissionCalls += 1;
            submittedPrompt = request.params?.prompt as string;
            result = { submitted: true };
            break;
          case "read_chatgpt_worker": {
            directReads += 1;
            const marker = submittedPrompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
            if (!marker) throw new Error("Submitted worker prompt did not contain a completion marker");
            result = {
              ready: true,
              generating: false,
              latestUserText: submittedPrompt,
              latestUserTruncated: false,
              latestAssistantText:
                directReads === 1
                  ? "Finished but first observation missed marker"
                  : `Recovered result\n${marker}`,
              latestAssistantTruncated: false,
              tab: { tabId: 42, windowId: 10, active: false, discarded: false, status: "complete" },
            };
            break;
          }
          case "read_chatgpt_worker_snapshot":
            result = {};
            break;
          case "get_active_tab":
            result = { tab: { tabId: 99 } };
            break;
          case "activate_worker_tab":
          case "reload_worker_tab":
          case "close_tab":
            result = {};
            break;
          default:
            throw new Error(`Unexpected browser method: ${request.method}`);
        }

        writeNativeMessage(fromExtension, { type: "response", id: request.id, result });
      },
      (error) => {
        throw error;
      },
    );

    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "recover", prompt: "answer once" }], 1);
    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissionCalls).toBe(1);
    expect(directReads).toBe(2);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      barrier: { satisfied: true },
      results: [{
        agent_id: "recover",
        result: { text: "Recovered result" },
        diagnostics: {
          observation_source: "backoff_reread",
          recovery_steps: ["current_state", "bounded_reread"],
          uncertainty_reason: "completion marker missing after generation appeared finished",
        },
      }],
      failed: [],
      pending: [],
    });
  });
});
