import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const instanceName = process.argv[2] ?? "chrome";

try {
  const { instances } = JSON.parse(
    await readFile(new URL("./instances.json", import.meta.url), "utf8"),
  );
  const instance = instances.find(({ name }) => name === instanceName);
  if (!instance) throw new Error(`Unknown Chrome instance: ${instanceName}`);

  const endpoint = process.env.CHROME_MCP_URL ?? `http://127.0.0.1:${instance.port}/mcp`;
  const healthUrl = new URL("/healthz", endpoint);

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
    const extensionId = status.structuredContent.extensionId;
    const extensionVersion = status.structuredContent.extensionVersion;
    const mcpVersion = status.structuredContent.mcpVersion;
    console.log("Chrome Browser MCP is ready.");
    console.log(`Extension ID: ${extensionId}`);
    console.log(`Extension version: ${extensionVersion ?? "unknown"}`);
    console.log(`MCP version: ${mcpVersion ?? "unknown (stale bridge)"}`);
    const diagnostics = status.structuredContent.diagnostics;
    if (diagnostics?.enabled) {
      console.log(`Diagnostics: ${diagnostics.level} (${diagnostics.file ?? "launcher stderr only"})`);
    } else {
      console.log("Diagnostics: off");
    }
    console.log(`Tools (${names.length}): ${names.join(", ")}`);
    if (extensionId !== instance.extensionId) {
      throw new Error(`Wrong instance: expected extension ${instance.extensionId}, got ${extensionId}`);
    }
    if (!mcpVersion) throw new Error("MCP bridge is stale: it does not report its version");
    if (extensionVersion !== mcpVersion) {
      throw new Error(`Version mismatch: extension=${extensionVersion ?? "unknown"}, mcp=${mcpVersion}`);
    }
  } finally {
    await client.close();
  }
} catch (error) {
  console.error(`Local verification failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Rebuild/reinstall the local checkout, then click Update on the already-loaded Chrome extension.");
  process.exitCode = 1;
}
