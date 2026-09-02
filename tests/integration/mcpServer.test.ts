// Public-seam specification for the job-based sub-agent runtime.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpMcpServer } from "../../src/bridge/mcpServer.js";
import type { BrowserClient } from "../../src/bridge/browserClient.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
});

/** Connects an MCP test client to a temporary loopback server backed by the supplied fake browser. */
async function connect(fakeBrowser: BrowserClient) {
  const httpServer = await startHttpMcpServer(fakeBrowser, 0);
  servers.push(httpServer);
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

/** Extracts the generated completion marker from the runtime's submitted worker prompt. */
function completionMarker(prompt: string): string {
  const marker = prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${prompt}`);
  return marker;
}

describe("MCP HTTP server", () => {
  it("advertises job-based agent tools instead of tab-based child-agent tools", async () => {
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => Promise.resolve({ method, args }),
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "browser_status",
      "list_tabs",
      "get_active_tab",
      "read_tab",
      "read_tabs",
      "search_tabs",
      "click",
      "type",
      "fill_form",
      "press_key",
      "scroll",
      "select_option",
      "navigate",
      "new_tab",
      "close_tab",
      "spawn_agents",
      "collect_agents",
      "cancel_agents",
    ]);
    expect(tools.tools.some((tool) => tool.name === "spawn_chatgpt_agent")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "read_chatgpt_agent")).toBe(false);
    const collectTool = tools.tools.find((tool) => tool.name === "collect_agents");
    expect(collectTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    await client.close();
  });

  it("queues excess workers and returns results only after identity and completion validation", async () => {
    const submitted = new Map<number, string>();
    let nextTabId = 77;
    const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        requests.push({ method, args });
        if (method === "new_tab") {
          const tabId = nextTabId++;
          return Promise.resolve({
            tab: {
              tabId,
              windowId: 1,
              index: 0,
              title: "ChatGPT",
              url: "https://chatgpt.com/",
              active: false,
              pinned: false,
              discarded: false,
              status: "loading",
              incognito: false,
            },
          });
        }
        if (method === "chatgpt_worker_submit") {
          submitted.set(args.tabId as number, args.prompt as string);
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          const tabId = args.tabId as number;
          const prompt = submitted.get(tabId);
          if (!prompt) throw new Error(`No submitted prompt for tab ${tabId}`);
          const answer = tabId === 77 ? "First answer" : "Second answer";
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: prompt,
            latestAssistantText: `${answer}\n${completionMarker(prompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({ method, args });
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: {
        tasks: [
          { agent_id: "architecture", prompt: "Review the architecture" },
          { agent_id: "security", prompt: "Review the security" },
        ],
        max_concurrency: 1,
      },
    });

    expect(spawned.structuredContent).toMatchObject({
      state: "RUNNING",
      jobs: [
        { agent_id: "architecture", state: "DISPATCHED" },
        { agent_id: "security", state: "CREATED" },
      ],
    });
    const spawnedContent = spawned.structuredContent as Record<string, unknown>;
    expect(typeof spawnedContent.run_id).toBe("string");
    expect(JSON.stringify(spawned.structuredContent)).not.toMatch(/tab_?id/i);
    expect(requests.filter((request) => request.method === "new_tab")).toHaveLength(1);

    const runId = spawnedContent.run_id as string;
    const firstCollect = await client.callTool({
      name: "collect_agents",
      arguments: { run_id: runId },
    });

    expect(firstCollect.structuredContent).toMatchObject({
      run_id: runId,
      state: "RUNNING",
      barrier: { satisfied: false },
      results: [
        {
          agent_id: "architecture",
          state: "VERIFIED_DONE",
          result: {
            type: "text",
            text: "First answer",
            contentIsUntrusted: true,
            truncated: false,
          },
        },
      ],
      failed: [],
    });
    expect(JSON.stringify(firstCollect.structuredContent)).toContain("untrusted");
    expect(JSON.stringify(firstCollect.structuredContent)).not.toMatch(/tab_?id/i);
    expect(requests.filter((request) => request.method === "new_tab")).toHaveLength(2);

    const secondCollect = await client.callTool({
      name: "collect_agents",
      arguments: { run_id: runId },
    });
    expect(secondCollect.structuredContent).toMatchObject({
      run_id: runId,
      state: "COMPLETE",
      barrier: { satisfied: true },
      results: [
        {
          agent_id: "architecture",
          state: "VERIFIED_DONE",
          result: { type: "text", text: "First answer" },
        },
        {
          agent_id: "security",
          state: "VERIFIED_DONE",
          result: {
            type: "text",
            text: "Second answer",
            contentIsUntrusted: true,
            truncated: false,
          },
        },
      ],
      failed: [],
      pending: [],
    });
    expect(JSON.stringify(secondCollect.structuredContent)).toContain("untrusted");
    await client.close();
  });
  it("retries transient worker submission failures but surfaces terminal failures", async () => {
    let transientAttempts = 0;
    const transientBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 91 } });
        if (method === "chatgpt_worker_submit") {
          transientAttempts += 1;
          if (transientAttempts === 1) {
            return Promise.reject(new Error("CHATGPT_NOT_READY: composer is still mounting"));
          }
          return Promise.resolve({ submitted: true });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const transientClient = await connect(transientBrowser);

    const transient = await transientClient.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "retry", prompt: "work" }], max_concurrency: 1 },
    });
    expect(transient.structuredContent).toMatchObject({
      state: "RUNNING",
      jobs: [{ agent_id: "retry", state: "DISPATCHED" }],
    });
    expect(transientAttempts).toBe(2);
    await transientClient.close();

    let terminalAttempts = 0;
    const terminalBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 92 } });
        if (method === "chatgpt_worker_submit") {
          terminalAttempts += 1;
          return Promise.reject(new Error("CHATGPT_UNSUPPORTED_PAGE: wrong origin"));
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const terminalClient = await connect(terminalBrowser);

    const terminal = await terminalClient.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "terminal", prompt: "work" }], max_concurrency: 1 },
    });
    expect(terminal.structuredContent).toMatchObject({
      state: "FAILED",
      jobs: [{
        agent_id: "terminal",
        state: "FAILED_TERMINAL",
        error: {
          code: "CHATGPT_UNSUPPORTED_PAGE",
          message: "wrong origin",
          retryable: false,
        },
      }],
    });
    expect(terminalAttempts).toBe(1);
    await terminalClient.close();
  });


  it("retries transient collection failures without leaking concurrency slots", async () => {
    let nextTabId = 101;
    let readAttempts = 0;
    let openedTabs = 0;
    let submittedPrompt = "";
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") {
          openedTabs += 1;
          return Promise.resolve({ tab: { tabId: nextTabId++ } });
        }
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          readAttempts += 1;
          if (readAttempts === 1) {
            return Promise.reject(new Error("EXTRACTION_FAILED: temporary read failure"));
          }
          return Promise.resolve({
            ready: true,
            generating: false,
            latestUserText: submittedPrompt,
            latestAssistantText: `Recovered answer\n${completionMarker(submittedPrompt)}`,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "recover", prompt: "work" }], max_concurrency: 1 },
    });
    const runId = (spawned.structuredContent as Record<string, unknown>).run_id as string;

    const firstCollect = await client.callTool({
      name: "collect_agents",
      arguments: { run_id: runId },
    });
    expect(firstCollect.structuredContent).toMatchObject({
      state: "RUNNING",
      failed: [{
        agent_id: "recover",
        state: "FAILED_TRANSIENT",
        error: { code: "EXTRACTION_FAILED", retryable: true },
      }],
    });
    expect(openedTabs).toBe(1);

    const secondCollect = await client.callTool({
      name: "collect_agents",
      arguments: { run_id: runId },
    });
    expect(secondCollect.structuredContent).toMatchObject({
      state: "COMPLETE",
      barrier: { satisfied: true },
      results: [{
        agent_id: "recover",
        state: "VERIFIED_DONE",
        result: { type: "text", text: "Recovered answer" },
      }],
      failed: [],
      pending: [],
    });
    expect(openedTabs).toBe(1);
    await client.close();
  });

  it("turns repeated transient collection failures terminal after a bounded retry budget", async () => {
    let submittedPrompt = "";
    let closeCalls = 0;
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 111 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          expect(submittedPrompt).not.toBe("");
          return Promise.reject(new Error("TIMEOUT: worker read timed out"));
        }
        if (method === "close_tab") {
          closeCalls += 1;
          return Promise.resolve({ closed: true });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "exhaust", prompt: "work" }], max_concurrency: 1 },
    });
    const runId = (spawned.structuredContent as Record<string, unknown>).run_id as string;

    await client.callTool({ name: "collect_agents", arguments: { run_id: runId } });
    await client.callTool({ name: "collect_agents", arguments: { run_id: runId } });
    const exhausted = await client.callTool({ name: "collect_agents", arguments: { run_id: runId } });

    expect(exhausted.structuredContent).toMatchObject({
      state: "FAILED",
      barrier: { satisfied: false },
      failed: [{
        agent_id: "exhaust",
        state: "FAILED_TERMINAL",
        error: { code: "TIMEOUT", retryable: false },
      }],
      pending: [],
    });
    expect(JSON.stringify(exhausted.structuredContent)).toMatch(/retry budget exhausted/);
    expect(closeCalls).toBe(1);
    await client.close();
  });

  it("reports cancellation coherently after some workers already completed", async () => {
    const submitted = new Map<number, string>();
    let nextTabId = 201;
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: nextTabId++ } });
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
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: {
        tasks: [
          { agent_id: "done", prompt: "finish first" },
          { agent_id: "cancelled", prompt: "wait second" },
        ],
        max_concurrency: 1,
      },
    });
    const runId = (spawned.structuredContent as Record<string, unknown>).run_id as string;

    const firstCollect = await client.callTool({ name: "collect_agents", arguments: { run_id: runId } });
    expect(firstCollect.structuredContent).toMatchObject({
      results: [{ agent_id: "done", state: "VERIFIED_DONE" }],
      pending: [{ agent_id: "cancelled", state: "DISPATCHED" }],
    });

    const cancelled = await client.callTool({ name: "cancel_agents", arguments: { run_id: runId } });
    expect(cancelled.structuredContent).toMatchObject({
      cancelled: true,
      jobs: [
        { agent_id: "done", state: "VERIFIED_DONE" },
        { agent_id: "cancelled", state: "CANCELLED" },
      ],
    });

    const afterCancel = await client.callTool({ name: "collect_agents", arguments: { run_id: runId } });
    expect(afterCancel.structuredContent).toMatchObject({
      state: "CANCELLED",
      barrier: { satisfied: false },
      results: [{
        agent_id: "done",
        state: "VERIFIED_DONE",
        result: { type: "text", text: "Done" },
      }],
      pending: [],
    });
    await client.close();
  });


  it("does not duplicate-submit when submission succeeds but its acknowledgement is lost", async () => {
    let submitCalls = 0;
    let readCalls = 0;
    let submittedPrompt = "";
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 121 } });
        if (method === "chatgpt_worker_submit") {
          submitCalls += 1;
          submittedPrompt = args.prompt as string;
          if (submitCalls === 1) {
            return Promise.reject(new Error("TIMEOUT: acknowledgement was lost"));
          }
          return Promise.resolve({ submitted: true });
        }
        if (method === "read_chatgpt_worker") {
          readCalls += 1;
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: submittedPrompt,
            latestAssistantText: null,
          });
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "idempotent", prompt: "work" }], max_concurrency: 1 },
    });

    expect(spawned.structuredContent).toMatchObject({
      state: "RUNNING",
      jobs: [{ agent_id: "idempotent", state: "DISPATCHED" }],
    });
    expect(submitCalls).toBe(1);
    expect(readCalls).toBe(1);
    await client.close();
  });

  it("fails terminally when a worker tab disappears during submission retry", async () => {
    let submitCalls = 0;
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 131 } });
        if (method === "chatgpt_worker_submit") {
          submitCalls += 1;
          if (submitCalls === 1) {
            return Promise.reject(new Error("CHATGPT_NOT_READY: composer is mounting"));
          }
          return Promise.reject(new Error("TAB_NOT_FOUND: worker tab closed"));
        }
        if (method === "read_chatgpt_worker") {
          return Promise.reject(new Error("TAB_NOT_FOUND: worker tab closed"));
        }
        if (method === "close_tab") return Promise.resolve({ closed: true });
        return Promise.resolve({});
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    const spawned = await client.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "closed", prompt: "work" }], max_concurrency: 1 },
    });

    expect(spawned.structuredContent).toMatchObject({
      state: "FAILED",
      jobs: [{
        agent_id: "closed",
        state: "FAILED_TERMINAL",
        error: { code: "TAB_NOT_FOUND", retryable: false },
      }],
    });
    expect(submitCalls).toBe(2);
    await client.close();
  });

  it("keeps runtime-owned worker tabs private from generic browser tools", async () => {
    const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
    let submittedPrompt = "";
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        requests.push({ method, args });
        if (method === "new_tab") return Promise.resolve({ tab: { tabId: 701 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        if (method === "list_tabs") {
          return Promise.resolve({
            tabs: [
              { tabId: 1, title: "Public", url: "https://example.com" },
              { tabId: 701, title: "ChatGPT worker", url: "https://chatgpt.com" },
            ],
            count: 2,
          });
        }
        if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 701 } });
        if (method === "read_tab") return Promise.resolve({ tab: { tabId: args.tabId }, page: { text: "public" } });
        if (method === "close_tab") return Promise.resolve({ closed: true });
        if (method === "read_chatgpt_worker") {
          return Promise.resolve({
            ready: true,
            generating: true,
            latestUserText: submittedPrompt,
            latestAssistantText: null,
            latestAssistantTruncated: false,
          });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const client = await connect(fakeBrowser);

    await client.callTool({
      name: "spawn_agents",
      arguments: { tasks: [{ agent_id: "private", prompt: "stay private" }], max_concurrency: 1 },
    });
    const listed = await client.callTool({ name: "list_tabs", arguments: {} });

    expect(listed.structuredContent).toEqual({
      tabs: [{ tabId: 1, title: "Public", url: "https://example.com" }],
      count: 1,
    });
    const workerRead = await client.callTool({ name: "read_tab", arguments: { tabId: 701 } });
    const workerBatchRead = await client.callTool({ name: "read_tabs", arguments: { tabIds: [1, 701] } });
    const workerClose = await client.callTool({ name: "close_tab", arguments: { tabId: 701 } });
    const activeWorker = await client.callTool({ name: "get_active_tab", arguments: {} });

    for (const result of [workerRead, workerBatchRead, workerClose, activeWorker]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("WORKER_TAB_PRIVATE");
    }
    expect(requests.filter((request) => ["read_tab", "close_tab"].includes(request.method))).toEqual([]);

    const publicRead = await client.callTool({ name: "read_tab", arguments: { tabId: 1 } });
    expect(publicRead.structuredContent).toEqual({ tab: { tabId: 1 }, page: { text: "public" } });
    expect(requests.filter((request) => request.method === "read_tab")).toEqual([
      { method: "read_tab", args: { tabId: 1, offset: 0, maxCharacters: 30_000, includeLinks: true } },
    ]);
    await client.close();
  });

});
