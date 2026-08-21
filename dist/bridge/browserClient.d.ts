import type { Readable, Writable } from "node:stream";
import type { BrowserMethod } from "./types.js";
export declare class BrowserClient {
    private readonly output;
    private readonly timeoutMs;
    private readonly pending;
    private ready;
    private extensionVersion;
    private extensionId;
    constructor(input: Readable, output: Writable, timeoutMs?: number);
    status(): {
        connected: boolean;
        extensionVersion: string | null;
        extensionId: string | null;
    };
    request<T>(method: BrowserMethod, params?: Record<string, unknown>): Promise<T>;
    private handleMessage;
    private failAll;
}
