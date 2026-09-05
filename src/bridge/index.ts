#!/usr/bin/env node
import { BrowserClient } from "./browserClient.js";
import { createDiagnosticsLogger } from "./diagnosticsLogger.js";
import { startHttpMcpServer } from "./mcpServer.js";

const EXPECTED_ORIGIN =
  process.env.CHROME_MCP_EXPECTED_ORIGIN ?? "chrome-extension://jlpddlfiallighiohmhhkemgbhofpnha/";
const origin = process.argv[2];
if (process.env.CHROME_MCP_SKIP_ORIGIN_CHECK !== "1" && origin !== EXPECTED_ORIGIN) {
  process.stderr.write(`Rejected native messaging origin: ${origin}\n`);
  process.exit(2);
}

const port = Number.parseInt(process.env.CHROME_MCP_PORT ?? "2091", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write("CHROME_MCP_PORT must be an integer between 1024 and 65535\n");
  process.exit(2);
}

const diagnostics = createDiagnosticsLogger({ component: process.env.CHROME_MCP_INSTANCE ?? "bridge" });
const browser = new BrowserClient(process.stdin, process.stdout, 20_000, diagnostics);
const httpServer = await startHttpMcpServer(browser, port, diagnostics);
diagnostics.log("info", "bridge.listening", { port });
process.stderr.write(`Chrome Browser MCP listening on http://127.0.0.1:${port}/mcp\n`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
