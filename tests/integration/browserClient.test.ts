import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BrowserClient, type BrowserError } from "../../src/bridge/browserClient.js";
import { NativeMessageReader, writeNativeMessage } from "../../src/bridge/nativeMessaging.js";

describe("BrowserClient", () => {
  it("round-trips a request over the native messaging protocol", async () => {
    const fromExtension = new PassThrough();
    const toExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, toExtension, 2_000);

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const requests: unknown[] = [];
    new NativeMessageReader(
      toExtension,
      (message) => {
        requests.push(message);
        const request = message as { id: string };
        writeNativeMessage(fromExtension, { type: "response", id: request.id, result: { tabs: [] } });
      },
      (error) => {
        throw error;
      },
    );

    await expect(client.request("list_tabs")).resolves.toEqual({ tabs: [] });
    expect(requests).toHaveLength(1);
    expect(client.status()).toEqual({ connected: true, extensionVersion: "0.1.0", extensionId: "test-extension" });
  });

  it("refuses browser calls before the extension is ready", async () => {
    const client = new BrowserClient(new PassThrough(), new PassThrough(), 50);
    await expect(client.request("list_tabs")).rejects.toThrow("not connected");
  });

  it("caches a valid ChatGPT worker snapshot event for internal consumers", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);

    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "Working on it",
        latestAssistantTruncated: false,
        revision: 3,
        timestamp: 1_700_000_000_000,
      },
    });

    expect(client.latestChatGptWorkerSnapshot(42)).toEqual({
      ready: true,
      generating: true,
      latestUserText: "Summarize this",
      latestUserTruncated: false,
      latestAssistantText: "Working on it",
      latestAssistantTruncated: false,
      revision: 3,
      timestamp: 1_700_000_000_000,
    });
  });

  it("forgets the cached ChatGPT worker snapshot for one tab", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "Done",
        latestAssistantTruncated: false,
        revision: 3,
        timestamp: 1_700_000_000_000,
      },
    });

    client.forgetChatGptWorkerSnapshot(42);

    expect(client.latestChatGptWorkerSnapshot(42)).toBeUndefined();
  });

  it("rejects oversized ChatGPT worker snapshot events", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "x".repeat(30_001),
        latestAssistantTruncated: true,
        revision: 3,
        timestamp: 1_700_000_000_000,
      },
    });

    expect(client.latestChatGptWorkerSnapshot(42)).toBeUndefined();
  });

  it("keeps the newest ChatGPT worker snapshot when events arrive out of order", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    const base = {
      type: "event" as const,
      event: "chatgpt_worker_snapshot" as const,
      tabId: 42,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "",
        latestAssistantTruncated: false,
        revision: 8,
        timestamp: 1_700_000_000_008,
      },
    };

    writeNativeMessage(fromExtension, { ...base, snapshot: { ...base.snapshot, latestAssistantText: "Newest" } });
    writeNativeMessage(fromExtension, {
      ...base,
      snapshot: { ...base.snapshot, latestAssistantText: "Stale", revision: 7, timestamp: 1_700_000_000_007 },
    });

    expect(client.latestChatGptWorkerSnapshot(42)?.latestAssistantText).toBe("Newest");
    expect(client.latestChatGptWorkerSnapshot(42)?.revision).toBe(8);
  });

  it("preserves the first completed response across a newer degraded same-turn snapshot", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    const marker = "<<<SUBAGENT_DONE:11111111-1111-1111-1111-111111111111>>>";
    const latestUserText = `SUBAGENT_PROTOCOL_VERSION: 1\n${marker}`;

    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText,
        latestUserTruncated: false,
        latestAssistantText: `First response\n${marker}`,
        latestAssistantTruncated: false,
        revision: 8,
        timestamp: 1_700_000_000_008,
      },
    });
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText,
        latestUserTruncated: false,
        latestAssistantText: "First response",
        latestAssistantTruncated: false,
        revision: 9,
        timestamp: 1_700_000_000_009,
      },
    });

    expect(client.latestChatGptWorkerSnapshot(42)).toEqual({
      ready: true,
      generating: false,
      latestUserText,
      latestUserTruncated: false,
      latestAssistantText: `First response\n${marker}`,
      latestAssistantTruncated: false,
      revision: 9,
      timestamp: 1_700_000_000_009,
    });

    const nextMarker = "<<<SUBAGENT_DONE:22222222-2222-2222-2222-222222222222>>>";
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: true,
        latestUserText: `next task\n${nextMarker}`,
        latestUserTruncated: false,
        latestAssistantText: null,
        latestAssistantTruncated: false,
        revision: 10,
        timestamp: 1_700_000_000_010,
      },
    });

    expect(client.latestChatGptWorkerSnapshot(42)).toMatchObject({
      latestUserText: `next task\n${nextMarker}`,
      latestAssistantText: null,
      revision: 10,
    });
  });

  it("clears ChatGPT worker snapshots when a new native connection becomes ready", () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "Done",
        latestAssistantTruncated: false,
        revision: 8,
        timestamp: 1_700_000_000_008,
      },
    });

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "reconnected-extension",
    });

    expect(client.latestChatGptWorkerSnapshot(42)).toBeUndefined();
  });

  it("clears ChatGPT worker snapshots when the native connection closes", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "event",
      event: "chatgpt_worker_snapshot",
      tabId: 42,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: "Summarize this",
        latestUserTruncated: false,
        latestAssistantText: "Done",
        latestAssistantTruncated: false,
        revision: 8,
        timestamp: 1_700_000_000_008,
      },
    });

    const ended = new Promise<void>((resolve) => fromExtension.once("end", resolve));
    fromExtension.end();
    await ended;

    expect(client.latestChatGptWorkerSnapshot(42)).toBeUndefined();
  });

  it("reports a structured transient error when a browser request times out", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 1);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    await expect(client.request("list_tabs")).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "TIMEOUT",
        detail: "Browser request timed out: list_tabs",
      }),
    );
  });

  it("reports a structured transient error when the native connection closes", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const request = client.request("list_tabs");
    fromExtension.end();

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "BROWSER_DISCONNECTED",
        detail: "Chrome native messaging connection closed",
      }),
    );
  });

  it("reports a non-retryable protocol error for malformed native frames", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const request = client.request("list_tabs");
    fromExtension.write(Buffer.from([1, 0, 0, 0, 123]));

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "BROWSER_PROTOCOL_ERROR",
      }),
    );
  });
});
