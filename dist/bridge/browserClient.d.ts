import type { Readable, Writable } from "node:stream";
import type { BrowserLifecycleEvent, BrowserMethod, ChatGptWorkerSnapshot } from "./types.js";
/** Represents a browser-bridge failure with a stable machine-readable code. */
export declare class BrowserError extends Error {
    readonly code: string;
    readonly detail: string;
    constructor(code: string, detail: string);
}
/** Sends typed requests to the connected Chrome extension over Native Messaging. */
export declare class BrowserClient {
    private readonly output;
    private readonly timeoutMs;
    private readonly pending;
    private readonly chatGptWorkerSnapshots;
    private readonly lifecycleListeners;
    private ready;
    private extensionVersion;
    private extensionId;
    /** Creates a client backed by the Native Messaging input and output streams. */
    constructor(input: Readable, output: Writable, timeoutMs?: number);
    /** Returns the extension connection state advertised by the latest ready message. */
    status(): {
        connected: boolean;
        extensionVersion: string | null;
        extensionId: string | null;
    };
    /** Subscribes to validated unsolicited worker snapshots and browser ready/reconnect notifications. */
    subscribeLifecycle(listener: (event: BrowserLifecycleEvent) => void): () => void;
    /** Returns the latest validated ephemeral ChatGPT worker snapshot for one tab. */
    latestChatGptWorkerSnapshot(tabId: number): ChatGptWorkerSnapshot | undefined;
    /** Removes the ephemeral ChatGPT worker snapshot retained for one tab. */
    forgetChatGptWorkerSnapshot(tabId: number): void;
    /** Sends one browser request and resolves it with the matching Native Messaging response. */
    request<T>(method: BrowserMethod, params?: Record<string, unknown>): Promise<T>;
    /** Routes a single decoded Native Messaging frame to connection state or its pending request. */
    private handleMessage;
    /** Caches one newer, bounded worker snapshot and returns its validated lifecycle event. */
    private cacheChatGptWorkerSnapshot;
    /** Delivers one lifecycle event without allowing observers to mutate cached evidence or disrupt parsing. */
    private emitLifecycle;
    /** Rejects all pending requests after the Native Messaging transport becomes unusable. */
    private failAll;
}
