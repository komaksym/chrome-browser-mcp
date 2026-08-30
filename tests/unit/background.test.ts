import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface NativeResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

let nativeMessageListener: ((message: unknown) => void) | undefined;
const nativeMessages: unknown[] = [];
const tabs = new Map<number, chrome.tabs.Tab>();
const executeScript = vi.fn();

const chromeApi = {
  runtime: {
    id: "test-extension",
    getManifest: () => ({ version: "0.1.0" }),
    connectNative: () => ({
      postMessage: (message: unknown) => nativeMessages.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => { nativeMessageListener = listener; } },
      onDisconnect: { addListener: vi.fn() },
    }),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  },
  tabs: {
    get: (tabId: number) => {
      const tab = tabs.get(tabId);
      return tab ? Promise.resolve(tab) : Promise.reject(new Error("TAB_NOT_FOUND: missing test tab"));
    },
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  scripting: { executeScript },
} as unknown as typeof chrome;

/** Sends one request through the native-message boundary and awaits its matching reply. */
async function request(method: string, params: Record<string, unknown>): Promise<NativeResponse> {
  const id = `request-${nativeMessages.length}`;
  nativeMessageListener?.({ type: "request", id, method, params });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve();
    const response = nativeMessages.find(
      (message): message is NativeResponse =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string; id?: string }).type === "response" &&
        (message as { id?: string }).id === id,
    );
    if (response) return response;
  }
  throw new Error(`No native response for ${method}`);
}

describe("extension background worker commands", () => {
  beforeAll(async () => {
    vi.stubGlobal("chrome", chromeApi);
    await import("../../src/extension/background.js");
  });

  beforeEach(() => {
    nativeMessages.splice(0);
    tabs.clear();
    executeScript.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("treats a ChatGPT tab with only a pending URL as transient navigation progress", async () => {
    tabs.set(47, {
      id: 47,
      url: "",
      pendingUrl: "https://chatgpt.com/",
      status: "loading",
      incognito: false,
      active: false,
      pinned: false,
      discarded: false,
      windowId: 1,
      index: 0,
    } as chrome.tabs.Tab);

    const response = await request("chatgpt_worker_submit", { tabId: 47, prompt: "wait for navigation" });

    expect(response).toMatchObject({ error: { code: "NAVIGATION_IN_PROGRESS" } });
    expect(response.error?.message).toContain("navigating");
    expect(executeScript).not.toHaveBeenCalled();
  });
});
