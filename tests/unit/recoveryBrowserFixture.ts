import type { BrowserClient } from "../../src/bridge/browserClient.js";

export interface RecoveryBrowserState {
  submittedPrompt: string;
  submissions: number;
  reads: number;
  reloads: number;
  activations: number[];
}

interface RecoveryBrowserOptions {
  read: (state: RecoveryBrowserState, args: Record<string, unknown>) => unknown;
  activate?: (tabId: number, state: RecoveryBrowserState) => unknown;
  reload?: (state: RecoveryBrowserState) => unknown;
}

/** Builds a configurable browser boundary for observation-recovery tests. */
export function createRecoveryBrowser(options: RecoveryBrowserOptions): {
  browser: BrowserClient;
  state: RecoveryBrowserState;
} {
  const state: RecoveryBrowserState = {
    submittedPrompt: "",
    submissions: 0,
    reads: 0,
    reloads: 0,
    activations: [],
  };

  const browser = {
    request: (method: string, args: Record<string, unknown> = {}) => {
      if (method === "resolve_agent_anchor") return Promise.resolve({ tab: { tabId: 99, windowId: 10 } });
      if (method === "new_tab") return Promise.resolve({ tab: { tabId: 1 } });
      if (method === "chatgpt_worker_submit") {
        state.submissions += 1;
        state.submittedPrompt = args.prompt as string;
        return Promise.resolve({ submitted: true });
      }
      if (method === "read_chatgpt_worker") {
        state.reads += 1;
        return options.read(state, args);
      }
      if (method === "get_active_tab") return Promise.resolve({ tab: { tabId: 99 } });
      if (method === "activate_worker_tab") {
        const tabId = args.tabId as number;
        state.activations.push(tabId);
        return options.activate?.(tabId, state) ?? Promise.resolve({});
      }
      if (method === "reload_worker_tab") {
        state.reloads += 1;
        return options.reload?.(state) ?? Promise.resolve({});
      }
      if (method === "close_tab") return Promise.resolve({ closed: true });
      return Promise.resolve({});
    },
  } as BrowserClient;

  return { browser, state };
}
