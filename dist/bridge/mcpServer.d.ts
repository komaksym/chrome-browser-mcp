import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserClient } from "./browserClient.js";
import { AgentRuntime } from "./agentRuntime.js";
/** Builds the local MCP server while preserving the agent runtime's private tab ownership boundary. */
export declare function createBrowserMcpServer(browser: BrowserClient, agentRuntime?: AgentRuntime): McpServer;
/** Starts the loopback HTTP MCP server and shares one private worker runtime across requests. */
export declare function startHttpMcpServer(browser: BrowserClient, port: number): Promise<HttpServer>;
