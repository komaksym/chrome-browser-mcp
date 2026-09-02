import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
import type { BrowserMethod, ChatGptWorkerSnapshot, IncomingNativeMessage, NativeRequest } from "./types.js";

const MAX_CHATGPT_WORKER_USER_CHARACTERS = 110_000;
const MAX_CHATGPT_WORKER_ASSISTANT_CHARACTERS = 30_000;

/** Represents a browser-bridge failure with a stable machine-readable code. */
export class BrowserError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BrowserError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** Distinguishes an invalid Native Messaging payload from a lost browser transport. */
function writeFailure(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const code = detail.startsWith("Native message exceeds") ? "BROWSER_PROTOCOL_ERROR" : "BROWSER_DISCONNECTED";
  return new BrowserError(code, detail);
}

/** Returns a snapshot only when an unsolicited native event has the bounded primitive fields the runtime accepts. */
function validChatGptWorkerSnapshot(raw: unknown): ChatGptWorkerSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const snapshot = raw as Record<string, unknown>;
  const revision = snapshot.revision;
  const timestamp = snapshot.timestamp;
  if (
    typeof snapshot.ready !== "boolean" ||
    typeof snapshot.generating !== "boolean" ||
    (typeof snapshot.latestUserText !== "string" && snapshot.latestUserText !== null) ||
    typeof snapshot.latestUserTruncated !== "boolean" ||
    (typeof snapshot.latestAssistantText !== "string" && snapshot.latestAssistantText !== null) ||
    typeof snapshot.latestAssistantTruncated !== "boolean" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision <= 0 ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  ) {
    return undefined;
  }
  if (
    (snapshot.latestUserText?.length ?? 0) > MAX_CHATGPT_WORKER_USER_CHARACTERS ||
    (snapshot.latestAssistantText?.length ?? 0) > MAX_CHATGPT_WORKER_ASSISTANT_CHARACTERS
  ) {
    return undefined;
  }
  return {
    ready: snapshot.ready,
    generating: snapshot.generating,
    latestUserText: snapshot.latestUserText,
    latestUserTruncated: snapshot.latestUserTruncated,
    latestAssistantText: snapshot.latestAssistantText,
    latestAssistantTruncated: snapshot.latestAssistantTruncated,
    revision,
    timestamp,
  };
}

/** Sends typed requests to the connected Chrome extension over Native Messaging. */
export class BrowserClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly chatGptWorkerSnapshots = new Map<number, ChatGptWorkerSnapshot>();
  private ready = false;
  private extensionVersion: string | null = null;
  private extensionId: string | null = null;

  /** Creates a client backed by the Native Messaging input and output streams. */
  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 20_000,
  ) {
    new NativeMessageReader(
      input,
      (message) => this.handleMessage(message),
      (error) => this.failAll(new BrowserError("BROWSER_PROTOCOL_ERROR", error.message)),
      (error) => this.failAll(new BrowserError("BROWSER_DISCONNECTED", error.message)),
    );
    input.on("end", () => this.failAll(new BrowserError("BROWSER_DISCONNECTED", "Chrome native messaging connection closed")));
    input.on("close", () => this.failAll(new BrowserError("BROWSER_DISCONNECTED", "Chrome native messaging connection closed")));
  }

  /** Returns the extension connection state advertised by the latest ready message. */
  status(): { connected: boolean; extensionVersion: string | null; extensionId: string | null } {
    return { connected: this.ready, extensionVersion: this.extensionVersion, extensionId: this.extensionId };
  }

  /** Returns the latest validated ephemeral ChatGPT worker snapshot for one tab. */
  latestChatGptWorkerSnapshot(tabId: number): ChatGptWorkerSnapshot | undefined {
    const snapshot = this.chatGptWorkerSnapshots.get(tabId);
    return snapshot ? { ...snapshot } : undefined;
  }

  /** Removes the ephemeral ChatGPT worker snapshot retained for one tab. */
  forgetChatGptWorkerSnapshot(tabId: number): void {
    this.chatGptWorkerSnapshots.delete(tabId);
  }

  /** Sends one browser request and resolves it with the matching Native Messaging response. */
  async request<T>(method: BrowserMethod, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ready && method !== "browser_status") {
      throw new BrowserError("BROWSER_DISCONNECTED", "Chrome extension is not connected");
    }
    const id = randomUUID();
    const message: NativeRequest = { type: "request", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError("TIMEOUT", `Browser request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      try {
        writeNativeMessage(this.output, message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(writeFailure(error));
      }
    });
  }

  /** Routes a single decoded Native Messaging frame to connection state or its pending request. */
  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return;
    const message = raw as IncomingNativeMessage;
    if (message.type === "ready") {
      this.chatGptWorkerSnapshots.clear();
      this.ready = true;
      this.extensionVersion = message.extensionVersion;
      this.extensionId = message.extensionId;
      return;
    }
    if (message.type === "event") {
      this.cacheChatGptWorkerSnapshot(message);
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new BrowserError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  /** Caches one newer, bounded worker snapshot from an unsolicited native event. */
  private cacheChatGptWorkerSnapshot(message: IncomingNativeMessage): void {
    if (
      message.type !== "event" ||
      message.event !== "chatgpt_worker_snapshot" ||
      !Number.isSafeInteger(message.tabId) ||
      message.tabId <= 0
    ) {
      return;
    }
    const snapshot = validChatGptWorkerSnapshot(message.snapshot);
    if (!snapshot) return;
    const current = this.chatGptWorkerSnapshots.get(message.tabId);
    if (current && snapshot.revision <= current.revision) return;
    this.chatGptWorkerSnapshots.set(message.tabId, snapshot);
  }

  /** Rejects all pending requests after the Native Messaging transport becomes unusable. */
  private failAll(error: BrowserError): void {
    this.ready = false;
    this.chatGptWorkerSnapshots.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
