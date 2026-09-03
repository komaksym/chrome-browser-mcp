import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserClient } from "../../src/bridge/browserClient.js";
import { NativeMessageReader, writeNativeMessage } from "../../src/bridge/nativeMessaging.js";
import type { NativeRequest } from "../../src/bridge/types.js";

describe("AgentRuntime with BrowserClient", () => {
  it("collects the preserved first streamed response after a newer degraded snapshot without resubmitting", async () => {
    const fromExtension = new PassThrough();
    const toExtension = new PassThrough();
    const browser = new BrowserClient(fromExtension, toExtension, 2_000);
    let submittedPrompt = "";
    let submissionCalls = 0;
    let directReads = 0;

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.12",
      extensionId: "test-extension",
    });

    new NativeMessageReader(
      toExtension,
      (message) => {
        const request = message as NativeRequest;
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
            submittedPrompt = request.params.prompt as string;
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
              latestAssistantText: `First response\n${marker}`,
              latestAssistantTruncated: false,
              tab: { tabId: 42, windowId: 10, active: false, discarded: false, status: "complete" },
            };
            break;
          }
          case "read_chatgpt_worker_snapshot":
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
    const marker = submittedPrompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
    if (!marker) throw new Error("Submitted worker prompt did not contain a completion marker");

    const timestamp = Date.now();
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText: submittedPrompt,
        latestUserTruncated: false,
        latestAssistantText: `First response\n${marker}`,
        latestAssistantTruncated: false,
        revision: 8,
        timestamp,
      },
    });
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: submittedPrompt,
        latestUserTruncated: false,
        latestAssistantText: "First response",
        latestAssistantTruncated: false,
        revision: 9,
        timestamp: timestamp + 1,
      },
    });

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(submissionCalls).toBe(1);
    expect(directReads).toBe(0);
    expect(collected).toMatchObject({
      state: "COMPLETE",
      barrier: { satisfied: true },
      results: [{ agent_id: "recover", result: { text: "First response" } }],
      failed: [],
      pending: [],
    });
  });
});
