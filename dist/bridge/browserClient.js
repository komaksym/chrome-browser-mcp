import { randomUUID } from "node:crypto";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
export class BrowserError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.name = "BrowserError";
    }
}
export class BrowserClient {
    output;
    timeoutMs;
    pending = new Map();
    ready = false;
    extensionVersion = null;
    extensionId = null;
    constructor(input, output, timeoutMs = 20_000) {
        this.output = output;
        this.timeoutMs = timeoutMs;
        new NativeMessageReader(input, (message) => this.handleMessage(message), (error) => this.failAll(error));
        input.on("end", () => this.failAll(new Error("Chrome native messaging connection closed")));
        input.on("close", () => this.failAll(new Error("Chrome native messaging connection closed")));
    }
    status() {
        return { connected: this.ready, extensionVersion: this.extensionVersion, extensionId: this.extensionId };
    }
    async request(method, params = {}) {
        if (!this.ready && method !== "browser_status") {
            throw new Error("Chrome extension is not connected");
        }
        const id = randomUUID();
        const message = { type: "request", id, method, params };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Browser request timed out: ${method}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timeout });
            try {
                writeNativeMessage(this.output, message);
            }
            catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    handleMessage(raw) {
        if (!raw || typeof raw !== "object" || !("type" in raw))
            return;
        const message = raw;
        if (message.type === "ready") {
            this.ready = true;
            this.extensionVersion = message.extensionVersion;
            this.extensionId = message.extensionId;
            return;
        }
        if (message.type !== "response" || typeof message.id !== "string")
            return;
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new BrowserError(message.error.code, message.error.message));
        }
        else {
            pending.resolve(message.result);
        }
    }
    failAll(error) {
        this.ready = false;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=browserClient.js.map