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

async function connect(fakeBrowser: BrowserClient) {
  const httpServer = await startHttpMcpServer(fakeBrowser, 0);
  servers.push(httpServer);
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

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
    await client.close();
  });

  it("queues excess workers and returns results only after identity and completion validation", async () => {
    const submitted = new Map<number, string>();
    let nextTabId = 77;
    const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
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
    expect(typeof spawned.structuredContent?.run_id).toBe("string");
    expect(JSON.stringify(spawned.structuredContent)).not.toMatch(/tab_?id/i);
    expect(requests.filter((request) => request.method === "new_tab")).toHaveLength(1);

    const runId = spawned.structuredContent?.run_id as string;
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
          result: { type: "text", text: "First answer" },
        },
      ],
      failed: [],
    });
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
          result: { type: "text", text: "Second answer" },
        },
      ],
      failed: [],
      pending: [],
    });
    await client.close();
  });
});
