import type { BrowserClient } from "../src/bridge/browserClient.js";

export interface TestAgentAnchor {
  tabId: number;
  windowId: number;
}

export const DEFAULT_TEST_AGENT_ANCHOR: TestAgentAnchor = { tabId: 99, windowId: 10 };

/** Decorates a fake browser request handler with deterministic run-anchor resolution. */
export function withAgentAnchor(
  request: (method: string, args: Record<string, unknown>) => unknown,
  anchor: TestAgentAnchor = DEFAULT_TEST_AGENT_ANCHOR,
): BrowserClient["request"] {
  return ((method: string, args: Record<string, unknown> = {}) => {
    if (method === "resolve_agent_anchor") return Promise.resolve({ tab: anchor });
    return request(method, args);
  }) as BrowserClient["request"];
}
