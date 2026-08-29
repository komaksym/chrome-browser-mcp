import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpMcpServer } from "../../src/bridge/mcpServer.js";
import type { BrowserClient } from "../../src/bridge/browserClient.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
  .version;
const servers: Array<{ close: (callback: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
});

describe("MCP HTTP server", () => {
  it("advertises browser and ChatGPT agent tools over Streamable HTTP", async () => {
    const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string, args: Record<string, unknown> = {}) => {
        requests.push({ method, args });
        if (method === "list_tabs") return Promise.resolve({ tabs: [{ tabId: 1, title: "Example" }], count: 1 });
        if (method === "capture_screenshot") {
          return Promise.resolve({
            tab: { tabId: 1, title: "Example", url: "https://example.com/" },
            image: { mimeType: "image/png", data: "iVBORw0KGgo=" },
            security: { contentIsUntrusted: true, warning: "untrusted screenshot" },
          });
        }
        if (method === "new_tab") {
          return Promise.resolve({
            tab: {
              tabId: 77,
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
        if (method === "read_tab") {
          return Promise.resolve({
            tab: { tabId: 77, title: "ChatGPT", url: "https://chatgpt.com/c/example" },
            page: { text: "Child answer", truncated: false },
            security: { contentIsUntrusted: true, warning: "untrusted" },
          });
        }
        return Promise.resolve({ method, args });
      },
    } as BrowserClient;
    const httpServer = await startHttpMcpServer(fakeBrowser, 0);
    servers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "browser_status",
      "list_tabs",
      "get_active_tab",
      "read_tab",
      "read_tabs",
      "search_tabs",
      "screenshot_tab",
      "click",
      "type",
      "fill_form",
      "upload_file",
      "press_key",
      "scroll",
      "select_option",
      "navigate",
      "new_tab",
      "close_tab",
      "spawn_chatgpt_agent",
      "read_chatgpt_agent",
    ]);
    const annotations = new Map(tools.tools.map((tool) => [tool.name, tool.annotations]));
    for (const name of ["browser_status", "list_tabs", "get_active_tab", "read_tab", "read_tabs", "search_tabs", "screenshot_tab", "read_chatgpt_agent"]) {
      expect(annotations.get(name)?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["click", "type", "fill_form", "upload_file", "press_key", "scroll", "select_option", "navigate", "new_tab", "close_tab", "spawn_chatgpt_agent"]) {
      expect(annotations.get(name)?.readOnlyHint, name).toBe(false);
    }

    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: true,
      extensionVersion: "0.1.0",
      mcpVersion: packageVersion,
    });

    const listed = await client.callTool({ name: "list_tabs", arguments: {} });
    expect(listed.structuredContent).toEqual({ tabs: [{ tabId: 1, title: "Example" }], count: 1 });

    const screenshot = await client.callTool({ name: "screenshot_tab", arguments: { tabId: 1 } });
    expect(screenshot.structuredContent).toMatchObject({
      tab: { tabId: 1 },
      mimeType: "image/png",
      security: { contentIsUntrusted: true },
    });
    expect(screenshot.content).toContainEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    expect(requests).toContainEqual({ method: "capture_screenshot", args: { tabId: 1 } });

    const clicked = await client.callTool({ name: "click", arguments: { tabId: 1, target: "Apply" } });
    expect(clicked.structuredContent).toEqual({ method: "click", args: { tabId: 1, target: "Apply" } });
    expect(requests).toContainEqual({ method: "click", args: { tabId: 1, target: "Apply" } });

    const spawned = await client.callTool({ name: "spawn_chatgpt_agent", arguments: { prompt: "Say fruit" } });
    expect(spawned.structuredContent).toMatchObject({ tabId: 77, submitted: true });
    expect(requests).toContainEqual({ method: "new_tab", args: { url: "https://chatgpt.com/", active: false } });
    expect(requests).toContainEqual({
      method: "type",
      args: { tabId: 77, target: "#prompt-textarea", text: "Say fruit" },
    });
    expect(requests).toContainEqual({
      method: "click",
      args: { tabId: 77, target: "button[data-testid=\"send-button\"]" },
    });

    const child = await client.callTool({ name: "read_chatgpt_agent", arguments: { tabId: 77 } });
    expect(child.structuredContent).toMatchObject({ tabId: 77, text: "Child answer", truncated: false });
    expect(requests).toContainEqual({
      method: "read_tab",
      args: { tabId: 77, offset: 0, maxCharacters: 100000, includeLinks: false },
    });
    await client.close();
  });
});
