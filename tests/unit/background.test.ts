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
const updateTab = vi.fn();
const updateWindow = vi.fn();

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
    update: updateTab,
    remove: vi.fn(),
  },
  windows: { update: updateWindow },
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
    vi.mocked(chromeApi.tabs.query).mockReset();
    vi.mocked(chromeApi.tabs.create).mockReset();
    executeScript.mockReset();
    updateTab.mockReset();
    updateWindow.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("restores a prior normal tab even when its URL is not HTTP(S)", async () => {
    const priorTab = {
      id: 12,
      url: "chrome://settings/",
      status: "complete",
      incognito: false,
      active: true,
      pinned: false,
      discarded: false,
      windowId: 3,
      index: 0,
    } as chrome.tabs.Tab;
    tabs.set(12, priorTab);
    updateWindow.mockResolvedValue({});
    updateTab.mockResolvedValue({ ...priorTab, active: true });

    const response = await request("activate_worker_tab", { tabId: 12, allowNonWorker: true });

    expect(response.error).toBeUndefined();
    expect(updateWindow).toHaveBeenCalledWith(3, { focused: true });
    expect(updateTab).toHaveBeenCalledWith(12, { active: true });
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
  it("selects the most recently accessed eligible ChatGPT tab and excludes worker tabs", async () => {
    vi.mocked(chromeApi.tabs.query).mockResolvedValue([
      {
        id: 10,
        url: "https://chatgpt.com/c/old",
        lastAccessed: 100,
        incognito: false,
        active: false,
        pinned: false,
        discarded: false,
        windowId: 1,
        index: 0,
      },
      {
        id: 11,
        url: "https://chatgpt.com/c/worker",
        lastAccessed: 300,
        incognito: false,
        active: false,
        pinned: false,
        discarded: false,
        windowId: 2,
        index: 0,
      },
      {
        id: 12,
        url: "https://chatgpt.com/c/new",
        lastAccessed: 200,
        incognito: false,
        active: true,
        pinned: false,
        discarded: false,
        windowId: 3,
        index: 0,
      },
    ] as chrome.tabs.Tab[]);

    const response = await request("resolve_chatgpt_anchor", { excludedTabIds: [11] });

    expect(response).toMatchObject({ result: { tab: { tabId: 12, windowId: 3 } } });
  });

  it("returns a stable anchor error when the stored parent leaves ChatGPT", async () => {
    tabs.set(47, {
      id: 47,
      url: "https://example.com/",
      incognito: false,
      active: true,
      pinned: false,
      discarded: false,
      windowId: 1,
      index: 0,
    } as chrome.tabs.Tab);

    const response = await request("resolve_chatgpt_anchor", { anchorTabId: 47 });

    expect(response).toMatchObject({ error: { code: "ANCHOR_UNAVAILABLE" } });
  });

  it("creates a worker tab in the explicitly requested window", async () => {
    vi.mocked(chromeApi.tabs.create).mockResolvedValue({
      id: 88,
      url: "https://chatgpt.com/",
      incognito: false,
      active: false,
      pinned: false,
      discarded: false,
      windowId: 9,
      index: 0,
    } as chrome.tabs.Tab);

    const response = await request("new_tab", { url: "https://chatgpt.com/", active: false, windowId: 9 });

    expect(response.error).toBeUndefined();
    expect(chromeApi.tabs.create).toHaveBeenCalledWith({
      url: "https://chatgpt.com/",
      active: false,
      windowId: 9,
    });
  });

});