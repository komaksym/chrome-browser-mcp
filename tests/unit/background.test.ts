import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface NativeResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

let nativeMessageListener: ((message: unknown) => void) | undefined;
let workerSnapshotListener: ((message: unknown, sender: chrome.runtime.MessageSender) => void) | undefined;
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
    onMessage: {
      addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
        workerSnapshotListener = listener;
      },
    },
  },
  tabs: {
    get: (tabId: number) => {
      const tab = tabs.get(tabId);
      return tab ? Promise.resolve(tab) : Promise.reject(new Error("TAB_NOT_FOUND: missing test tab"));
    },
    query: vi.fn<() => Promise<chrome.tabs.Tab[]>>(() => Promise.resolve([])),
    create: vi.fn<() => Promise<chrome.tabs.Tab>>(() => Promise.resolve(undefined as unknown as chrome.tabs.Tab)),
    update: updateTab,
    remove: vi.fn(),
    onRemoved: { addListener: vi.fn() },
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
    (chromeApi.tabs.query as unknown as { mockResolvedValue: (value: chrome.tabs.Tab[]) => void }).mockResolvedValue([
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

  it("creates a tab in the explicitly requested window", async () => {
    (chromeApi.tabs.create as unknown as { mockResolvedValue: (value: chrome.tabs.Tab) => void }).mockResolvedValue({
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

  it("opens an agent worker in the stored parent window with the parent as opener", async () => {
    const parent = {
      id: 47,
      url: "https://chatgpt.com/c/parent",
      incognito: false,
      active: false,
      pinned: false,
      discarded: false,
      windowId: 9,
      index: 0,
    } as chrome.tabs.Tab;
    tabs.set(47, parent);
    (chromeApi.tabs.create as unknown as { mockResolvedValue: (value: chrome.tabs.Tab) => void }).mockResolvedValue({
      ...parent,
      id: 88,
      url: "https://chatgpt.com/",
      openerTabId: 47,
    });

    const response = await request("open_agent_worker_tab", { anchorTabId: 47 });

    expect(response.error).toBeUndefined();
    expect(chromeApi.tabs.create).toHaveBeenCalledWith({
      url: "https://chatgpt.com/",
      active: false,
      windowId: 9,
      openerTabId: 47,
    });
  });

  it("retries worker creation when the parent moves windows during creation", async () => {
    const parent = {
      id: 47,
      url: "https://chatgpt.com/c/parent",
      incognito: false,
      active: false,
      pinned: false,
      discarded: false,
      windowId: 4,
      index: 0,
    } as chrome.tabs.Tab;
    tabs.set(47, parent);
    vi.mocked(chromeApi.tabs.create)
      .mockImplementationOnce(async () => {
        tabs.set(47, { ...parent, windowId: 6 });
        throw new Error("opener tab moved");
      })
      .mockResolvedValueOnce({ ...parent, id: 88, windowId: 6, openerTabId: 47 } as chrome.tabs.Tab);

    const response = await request("open_agent_worker_tab", { anchorTabId: 47 });

    expect(response).toMatchObject({ result: { tab: { tabId: 88, windowId: 6 } } });
    expect(chromeApi.tabs.create).toHaveBeenNthCalledWith(1, {
      url: "https://chatgpt.com/",
      active: false,
      windowId: 4,
      openerTabId: 47,
    });
    expect(chromeApi.tabs.create).toHaveBeenNthCalledWith(2, {
      url: "https://chatgpt.com/",
      active: false,
      windowId: 6,
      openerTabId: 47,
    });
  });

  it("forwards only newer bounded worker snapshots through the native event channel", () => {
    const snapshot = {
      ready: true,
      generating: true,
      latestUserText: "worker prompt",
      latestUserTruncated: false,
      latestAssistantText: "partial answer",
      latestAssistantTruncated: false,
      revision: 4,
      timestamp: 1_000,
    };
    const sender = { tab: { id: 77 } } as chrome.runtime.MessageSender;

    workerSnapshotListener?.({ type: "chatgpt_worker_snapshot", tabId: 77, snapshot }, sender);
    workerSnapshotListener?.({
      type: "chatgpt_worker_snapshot",
      tabId: 77,
      snapshot: { ...snapshot, revision: 3, timestamp: 2_000 },
    }, sender);
    workerSnapshotListener?.({
      type: "chatgpt_worker_snapshot",
      tabId: 77,
      snapshot: { ...snapshot, revision: 5, timestamp: 3_000 },
    }, { tab: { id: 76 } } as chrome.runtime.MessageSender);
    workerSnapshotListener?.({
      type: "chatgpt_worker_snapshot",
      tabId: 77,
      snapshot: { ...snapshot, revision: 6, timestamp: 4_000 },
    }, {} as chrome.runtime.MessageSender);

    expect(nativeMessages).toContainEqual({
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 77,
      snapshot,
    });
    expect(nativeMessages.filter((message) => (
      typeof message === "object" && message !== null && (message as { type?: string }).type === "event"
    ))).toHaveLength(1);
  });

  it("serves a cached worker snapshot without rereading the virtualized DOM", async () => {
    const snapshot = {
      ready: true,
      generating: false,
      latestUserText: "worker prompt",
      latestUserTruncated: false,
      latestAssistantText: "answer\n<<<SUBAGENT_DONE:marker>>>",
      latestAssistantTruncated: false,
      revision: 8,
      timestamp: 2_000,
    };
    tabs.set(78, {
      id: 78,
      url: "https://chatgpt.com/",
      status: "complete",
      incognito: false,
      active: false,
      pinned: false,
      discarded: false,
      windowId: 1,
      index: 0,
    } as chrome.tabs.Tab);
    workerSnapshotListener?.(
      { type: "chatgpt_worker_snapshot", tabId: 78, snapshot },
      { tab: { id: 78 } } as chrome.runtime.MessageSender,
    );

    const response = await request("read_chatgpt_worker_snapshot", { tabId: 78, afterRevision: 0 });

    expect(response).toMatchObject({ result: { snapshot, tab: { tabId: 78 } } });
    expect(executeScript).not.toHaveBeenCalled();
  });

});
