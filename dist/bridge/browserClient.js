import { randomUUID } from "node:crypto";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
import { createDiagnosticsLogger } from "./diagnosticsLogger.js";
const MAX_CHATGPT_WORKER_USER_CHARACTERS = 110_000;
const MAX_CHATGPT_WORKER_ASSISTANT_CHARACTERS = 30_000;
/** Represents a browser-bridge failure with a stable machine-readable code. */
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
/** Distinguishes an invalid Native Messaging payload from a lost browser transport. */
function writeFailure(error) {
    if (error instanceof BrowserError)
        return error;
    const detail = error instanceof Error ? error.message : String(error);
    const code = detail.startsWith("Native message exceeds") ? "BROWSER_PROTOCOL_ERROR" : "BROWSER_DISCONNECTED";
    return new BrowserError(code, detail);
}
/** Extracts a stable error code without recording implementation messages. */
function diagnosticsErrorCode(error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return code ?? error.name;
}
/** Returns a snapshot only when an unsolicited native event has the bounded primitive fields the runtime accepts. */
function validChatGptWorkerSnapshot(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const snapshot = raw;
    const revision = snapshot.revision;
    const timestamp = snapshot.timestamp;
    if (typeof snapshot.ready !== "boolean" ||
        typeof snapshot.generating !== "boolean" ||
        (typeof snapshot.latestUserText !== "string" && snapshot.latestUserText !== null) ||
        typeof snapshot.latestUserTruncated !== "boolean" ||
        (typeof snapshot.latestAssistantText !== "string" && snapshot.latestAssistantText !== null) ||
        typeof snapshot.latestAssistantTruncated !== "boolean" ||
        (snapshot.rateLimited !== undefined && typeof snapshot.rateLimited !== "boolean") ||
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision <= 0 ||
        typeof timestamp !== "number" ||
        !Number.isSafeInteger(timestamp) ||
        timestamp <= 0) {
        return undefined;
    }
    if ((snapshot.latestUserText?.length ?? 0) > MAX_CHATGPT_WORKER_USER_CHARACTERS ||
        (snapshot.latestAssistantText?.length ?? 0) > MAX_CHATGPT_WORKER_ASSISTANT_CHARACTERS) {
        return undefined;
    }
    return {
        ready: snapshot.ready,
        generating: snapshot.generating,
        latestUserText: snapshot.latestUserText,
        latestUserTruncated: snapshot.latestUserTruncated,
        latestAssistantText: snapshot.latestAssistantText,
        latestAssistantTruncated: snapshot.latestAssistantTruncated,
        ...(typeof snapshot.rateLimited === "boolean" ? { rateLimited: snapshot.rateLimited } : {}),
        revision,
        timestamp,
    };
}
const SUBAGENT_COMPLETION_MARKER = /<<<SUBAGENT_DONE:[^>\r\n]+>>>/g;
/** Returns the protocol marker carried by a fully observable worker user turn. */
function workerTurnMarker(snapshot) {
    if (snapshot.latestUserTruncated || typeof snapshot.latestUserText !== "string")
        return undefined;
    return snapshot.latestUserText.match(SUBAGENT_COMPLETION_MARKER)?.at(-1);
}
/** Returns the marker only when this snapshot contains a completed response for its own worker turn. */
function completedWorkerMarker(snapshot) {
    const marker = workerTurnMarker(snapshot);
    if (!marker || !snapshot.latestAssistantText)
        return undefined;
    return snapshot.latestAssistantText.trimEnd().endsWith(marker) ? marker : undefined;
}
/** Keeps completed current-turn text sticky while accepting newer lifecycle state and revisions. */
function preserveCompletedWorkerEvidence(current, incoming) {
    const completedMarker = completedWorkerMarker(current);
    if (!completedMarker || completedWorkerMarker(incoming) === completedMarker)
        return incoming;
    const incomingMarker = workerTurnMarker(incoming);
    if (incomingMarker !== undefined && incomingMarker !== completedMarker)
        return incoming;
    return {
        ...incoming,
        latestUserText: incomingMarker === completedMarker ? incoming.latestUserText : current.latestUserText,
        latestUserTruncated: incomingMarker === completedMarker ? incoming.latestUserTruncated : current.latestUserTruncated,
        latestAssistantText: current.latestAssistantText,
        latestAssistantTruncated: current.latestAssistantTruncated,
    };
}
/** Sends typed requests to the connected Chrome extension over Native Messaging. */
export class BrowserClient {
    output;
    timeoutMs;
    diagnostics;
    pending = new Map();
    chatGptWorkerSnapshots = new Map();
    lifecycleListeners = new Set();
    ready = false;
    extensionVersion = null;
    extensionId = null;
    /** Creates a client backed by the Native Messaging input and output streams. */
    constructor(input, output, timeoutMs = 20_000, diagnostics = createDiagnosticsLogger({ component: "browser" })) {
        this.output = output;
        this.timeoutMs = timeoutMs;
        this.diagnostics = diagnostics;
        new NativeMessageReader(input, (message) => this.handleMessage(message), (error) => this.failAll(new BrowserError("BROWSER_PROTOCOL_ERROR", error.message)), (error) => this.failAll(new BrowserError("BROWSER_DISCONNECTED", error.message)));
        input.on("end", () => this.failAll(new BrowserError("BROWSER_DISCONNECTED", "Chrome native messaging connection closed")));
        input.on("close", () => this.failAll(new BrowserError("BROWSER_DISCONNECTED", "Chrome native messaging connection closed")));
    }
    /** Returns the extension connection state advertised by the latest ready message. */
    status() {
        return { connected: this.ready, extensionVersion: this.extensionVersion, extensionId: this.extensionId };
    }
    /** Subscribes to validated unsolicited worker snapshots and browser ready/reconnect notifications. */
    subscribeLifecycle(listener) {
        this.lifecycleListeners.add(listener);
        return () => this.lifecycleListeners.delete(listener);
    }
    /** Returns the latest validated ephemeral ChatGPT worker snapshot for one tab. */
    latestChatGptWorkerSnapshot(tabId) {
        const snapshot = this.chatGptWorkerSnapshots.get(tabId);
        return snapshot ? { ...snapshot } : undefined;
    }
    /** Removes the ephemeral ChatGPT worker snapshot retained for one tab. */
    forgetChatGptWorkerSnapshot(tabId) {
        this.chatGptWorkerSnapshots.delete(tabId);
    }
    /** Sends one browser request and resolves it with the matching Native Messaging response. */
    async request(method, params = {}) {
        if (!this.ready && method !== "browser_status") {
            const error = new BrowserError("BROWSER_DISCONNECTED", "Chrome extension is not connected");
            this.diagnostics.log("error", "browser.request.failed", { method, errorCode: error.code });
            throw error;
        }
        const id = randomUUID();
        const startedAt = Date.now();
        const message = { type: "request", id, method, params };
        this.diagnostics.log("debug", "browser.request.started", { method });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                const error = new BrowserError("TIMEOUT", `Browser request timed out: ${method}`);
                this.diagnostics.log("error", "browser.request.failed", {
                    method,
                    errorCode: error.code,
                    durationMs: Date.now() - startedAt,
                });
                reject(error);
            }, this.timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    this.diagnostics.log("debug", "browser.request.succeeded", {
                        method,
                        durationMs: Date.now() - startedAt,
                    });
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    this.diagnostics.log("error", "browser.request.failed", {
                        method,
                        errorCode: diagnosticsErrorCode(error),
                        durationMs: Date.now() - startedAt,
                    });
                    reject(error);
                },
                timeout,
            });
            try {
                writeNativeMessage(this.output, message);
            }
            catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                const failure = writeFailure(error);
                this.diagnostics.log("error", "browser.request.failed", {
                    method,
                    errorCode: failure.code,
                    durationMs: Date.now() - startedAt,
                });
                reject(failure);
            }
        });
    }
    /** Routes a single decoded Native Messaging frame to connection state or its pending request. */
    handleMessage(raw) {
        if (!raw || typeof raw !== "object" || !("type" in raw))
            return;
        const message = raw;
        if (message.type === "ready") {
            this.chatGptWorkerSnapshots.clear();
            this.ready = true;
            this.extensionVersion = message.extensionVersion;
            this.extensionId = message.extensionId;
            this.diagnostics.log("info", "browser.connection.ready", {
                extensionVersion: message.extensionVersion,
                extensionId: message.extensionId,
            });
            this.emitLifecycle({
                type: "ready",
                extensionVersion: message.extensionVersion,
                extensionId: message.extensionId,
            });
            return;
        }
        if (message.type === "event") {
            const event = this.validLifecycleEvent(message);
            if (event?.type === "chatgpt_worker_snapshot") {
                this.diagnostics.log("debug", "browser.lifecycle.event", {
                    eventName: event.type,
                    tabId: event.tabId,
                    revision: event.snapshot.revision,
                    ready: event.snapshot.ready,
                    generating: event.snapshot.generating,
                });
            }
            else if (event?.type === "agent_worker_tab_removed") {
                this.diagnostics.log("info", "browser.lifecycle.event", {
                    eventName: event.type,
                    tabId: event.tabId,
                });
            }
            if (event)
                this.emitLifecycle(event);
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
    /** Validates one bounded native event and normalizes it for lifecycle consumers. */
    validLifecycleEvent(message) {
        if (message.type !== "event")
            return undefined;
        if (message.event === "agent_worker_tab_removed") {
            if (!Number.isSafeInteger(message.tabId) || message.tabId <= 0)
                return undefined;
            this.chatGptWorkerSnapshots.delete(message.tabId);
            return { type: "agent_worker_tab_removed", tabId: message.tabId };
        }
        return this.cacheChatGptWorkerSnapshot(message);
    }
    /** Caches one newer bounded snapshot and returns lifecycle evidence without regressing current-turn completion. */
    cacheChatGptWorkerSnapshot(message) {
        if (message.type !== "event" ||
            message.event !== "chatgpt_worker_snapshot" ||
            !Number.isSafeInteger(message.tabId) ||
            message.tabId <= 0) {
            return undefined;
        }
        const snapshot = validChatGptWorkerSnapshot(message.snapshot);
        if (!snapshot)
            return undefined;
        const current = this.chatGptWorkerSnapshots.get(message.tabId);
        if (current && snapshot.revision <= current.revision)
            return undefined;
        const cached = current ? preserveCompletedWorkerEvidence(current, snapshot) : snapshot;
        this.chatGptWorkerSnapshots.set(message.tabId, cached);
        return { type: "chatgpt_worker_snapshot", tabId: message.tabId, snapshot: { ...cached } };
    }
    /** Delivers one lifecycle event without allowing observers to mutate cached evidence or disrupt parsing. */
    emitLifecycle(event) {
        for (const listener of this.lifecycleListeners) {
            const delivered = event.type === "chatgpt_worker_snapshot"
                ? { ...event, snapshot: { ...event.snapshot } }
                : { ...event };
            try {
                listener(delivered);
            }
            catch {
                // A lifecycle observer cannot be allowed to disrupt Native Messaging protocol handling.
            }
        }
    }
    /** Rejects all pending requests after the Native Messaging transport becomes unusable. */
    failAll(error) {
        const wasConnected = this.ready;
        const pendingCount = this.pending.size;
        this.ready = false;
        this.chatGptWorkerSnapshots.clear();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        if (wasConnected || pendingCount > 0) {
            this.diagnostics.log("error", "browser.connection.lost", {
                errorCode: error.code,
                pendingCount,
            });
        }
    }
}
//# sourceMappingURL=browserClient.js.map