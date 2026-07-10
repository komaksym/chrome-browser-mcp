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

describe("MCP HTTP server", () => {
  it("advertises and calls read-only Chrome tools over Streamable HTTP", async () => {
    const fakeBrowser = {
      status: () => ({ connected: true, extensionVersion: "0.1.0", extensionId: "abc" }),
      request: (method: string) => Promise.resolve(method === "list_tabs" ? { tabs: [{ tabId: 1, title: "Example" }], count: 1 } : {}),
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
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const result = await client.callTool({ name: "list_tabs", arguments: {} });
    expect(result.structuredContent).toEqual({ tabs: [{ tabId: 1, title: "Example" }], count: 1 });
    await client.close();
  });
});
