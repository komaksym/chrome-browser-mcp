import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
import type { BrowserMethod, IncomingNativeMessage, NativeRequest } from "./types.js";

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

/** Sends typed requests to the connected Chrome extension over Native Messaging. */
export class BrowserClient {
  private readonly pending = new Map<string, PendingRequest>();
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
      this.ready = true;
      this.extensionVersion = message.extensionVersion;
      this.extensionId = message.extensionId;
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

  /** Rejects all pending requests after the Native Messaging transport becomes unusable. */
  private failAll(error: BrowserError): void {
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
