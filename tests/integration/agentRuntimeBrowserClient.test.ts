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
          case "close_tab":
            result = { closed: true };
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

  it("repairs stale capacity after BrowserClient reconnect clears old snapshots", async () => {
    const fromExtension = new PassThrough();
    const toExtension = new PassThrough();
    const browser = new BrowserClient(fromExtension, toExtension, 2_000);
    const liveTabs = new Set<number>();
    const submitted = new Map<number, { prompt: string; timestamp: number }>();
    let nextTabId = 1;
    let terminalSnapshotAvailable = false;
    let directReads = 0;

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.17",
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
          case "open_agent_worker_tab": {
            const tabId = nextTabId++;
            liveTabs.add(tabId);
            result = { tab: { tabId } };
            break;
          }
          case "chatgpt_worker_submit": {
            const tabId = request.params.tabId as number;
            const timestamp = Date.now();
            submitted.set(tabId, { prompt: request.params.prompt as string, timestamp });
            result = { submitted: true, snapshot: { revision: 1, timestamp } };
            break;
          }
          case "list_tabs":
            result = { tabs: [...liveTabs].map((tabId) => ({ tabId })) };
            break;
          case "read_chatgpt_worker_snapshot": {
            const tabId = request.params.tabId as number;
            const current = submitted.get(tabId);
            if (!terminalSnapshotAvailable || tabId !== 1 || !current) {
              result = {};
              break;
            }
            const marker = current.prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
            if (!marker) throw new Error("Submitted worker prompt did not contain a completion marker");
            result = {
              snapshot: {
                ready: true,
                generating: false,
                latestUserText: current.prompt,
                latestUserTruncated: false,
                latestAssistantText: `Reconnected answer\n${marker}`,
                latestAssistantTruncated: false,
                revision: 3,
                timestamp: current.timestamp + 2,
              },
            };
            break;
          }
          case "read_chatgpt_worker":
            directReads += 1;
            result = {};
            break;
          case "close_tab": {
            const tabId = request.params.tabId as number;
            liveTabs.delete(tabId);
            result = { closed: true };
            break;
          }
          default:
            throw new Error(`Unexpected browser method: ${request.method}`);
        }

        writeNativeMessage(fromExtension, { type: "response", id: request.id, result });
      },
      (error) => {
        throw error;
      },
    );

    const runtime = new AgentRuntime(browser, { maxActiveWorkers: 1 });
    const spawned = await runtime.spawnAgents(
      [
        { agent_id: "active", prompt: "active" },
        { agent_id: "queued", prompt: "queued" },
      ],
      1,
      "browser-client-reconnect-repair",
    );
    expect(spawned.jobs[0]?.state).toBe("DISPATCHED");
    expect(spawned.jobs[1]?.state).toBe("CREATED");

    const first = submitted.get(1);
    if (!first) throw new Error("expected first worker submission");
    const marker = first.prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
    if (!marker) throw new Error("Submitted worker prompt did not contain a completion marker");
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 1,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText: first.prompt,
        latestUserTruncated: false,
        latestAssistantText: `old partial\n${marker}`,
        latestAssistantTruncated: false,
        revision: 2,
        timestamp: first.timestamp + 1,
      },
    });
    terminalSnapshotAvailable = true;

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.17",
      extensionId: "reconnected-extension",
    });

    for (let attempt = 0; attempt < 100 && submitted.size < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    expect(submitted.size).toBe(2);
    expect(directReads).toBe(0);
    const collected = await runtime.collectAgents(spawned.run_id);
    expect(collected).toMatchObject({
      state: "RUNNING",
      results: [{ agent_id: "active", result: { type: "text", text: "Reconnected answer" } }],
      failed: [],
      pending: [{ agent_id: "queued", state: "GENERATING" }],
    });
  });
});
