import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
import type { BrowserMethod, IncomingNativeMessage, NativeRequest } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BrowserClient {
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private extensionVersion: string | null = null;
  private extensionId: string | null = null;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 20_000,
  ) {
    new NativeMessageReader(input, (message) => this.handleMessage(message), (error) => this.failAll(error));
    input.on("end", () => this.failAll(new Error("Chrome native messaging connection closed")));
    input.on("close", () => this.failAll(new Error("Chrome native messaging connection closed")));
  }

  status(): { connected: boolean; extensionVersion: string | null; extensionId: string | null } {
    return { connected: this.ready, extensionVersion: this.extensionVersion, extensionId: this.extensionId };
  }

  async request<T>(method: BrowserMethod, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ready && method !== "browser_status") {
      throw new Error("Chrome extension is not connected");
    }
    const id = randomUUID();
    const message: NativeRequest = { type: "request", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      try {
        writeNativeMessage(this.output, message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

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
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
