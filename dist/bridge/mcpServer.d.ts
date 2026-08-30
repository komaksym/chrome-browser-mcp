import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserClient } from "./browserClient.js";
import { AgentRuntime } from "./agentRuntime.js";
export declare function createBrowserMcpServer(browser: BrowserClient, agentRuntime?: AgentRuntime): McpServer;
export declare function startHttpMcpServer(browser: BrowserClient, port: number): Promise<HttpServer>;
