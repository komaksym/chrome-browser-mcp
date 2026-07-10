import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.CHROME_MCP_URL ?? "http://127.0.0.1:2091/mcp";
const healthUrl = new URL("/healthz", endpoint);

try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
  const health = await response.json();
  if (!health.browser?.connected) throw new Error("Chrome extension is not connected");

  const client = new Client({ name: "chrome-browser-mcp-verifier", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const tools = await client.listTools();
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    const names = tools.tools.map((tool) => tool.name);
    console.log("Chrome Browser MCP is ready.");
    console.log(`Extension ID: ${status.structuredContent.extensionId}`);
    console.log(`Tools (${names.length}): ${names.join(", ")}`);
  } finally {
    await client.close();
  }
} catch (error) {
  console.error(`Local verification failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Open Chrome, enable the unpacked extension, and rerun npm run install:mac if the checkout moved.");
  process.exitCode = 1;
}
