import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { NativeMessageReader, writeNativeMessage } from "./nativeMessaging.js";
import type {
  BrowserLifecycleEvent,
  BrowserMethod,
  ChatGptWorkerSnapshot,
  IncomingNativeMessage,
  NativeRequest,
} from "./types.js";

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

/** Captures one consistent browser tab listing and the worker snapshots observed for those tabs. */
export interface WorkerTabObservation {
  tabIds: Set<number>;
  snapshots: Map<number, ChatGptWorkerSnapshot>;
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

const SUBAGENT_COMPLETION_MARKER = /<<<SUBAGENT_DONE:[^>\r\n]+>>>/g;

/** Returns the protocol marker carried by a fully observable worker user turn. */
function workerTurnMarker(snapshot: ChatGptWorkerSnapshot): string | undefined {
  if (snapshot.latestUserTruncated || typeof snapshot.latestUserText !== "string") return undefined;
  return snapshot.latestUserText.match(SUBAGENT_COMPLETION_MARKER)?.at(-1);
}

/** Returns the marker only when this snapshot contains a completed response for its own worker turn. */
function completedWorkerMarker(snapshot: ChatGptWorkerSnapshot): string | undefined {
  const marker = workerTurnMarker(snapshot);
  if (!marker || !snapshot.latestAssistantText) return undefined;
  return snapshot.latestAssistantText.trimEnd().endsWith(marker) ? marker : undefined;
}

/** Keeps completed current-turn text sticky while accepting newer lifecycle state and revisions. */
function preserveCompletedWorkerEvidence(
  current: ChatGptWorkerSnapshot,
  incoming: ChatGptWorkerSnapshot,
): ChatGptWorkerSnapshot {
  const completedMarker = completedWorkerMarker(current);
  if (!completedMarker || completedWorkerMarker(incoming) === completedMarker) return incoming;

  const incomingMarker = workerTurnMarker(incoming);
  if (incomingMarker !== undefined && incomingMarker !== completedMarker) return incoming;

  return {
    ...incoming,
    latestUserText: incomingMarker === completedMarker ? incoming.latestUserText : current.latestUserText,
    latestUserTruncated:
      incomingMarker === completedMarker ? incoming.latestUserTruncated : current.latestUserTruncated,
    latestAssistantText: current.latestAssistantText,
    latestAssistantTruncated: current.latestAssistantTruncated,
  };
}

/** Sends typed requests to the connected Chrome extension over Native Messaging. */
export class BrowserClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly chatGptWorkerSnapshots = new Map<number, ChatGptWorkerSnapshot>();
  private readonly lifecycleListeners = new Set<(event: BrowserLifecycleEvent) => void>();
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

  /** Subscribes to validated unsolicited worker snapshots and browser ready/reconnect notifications. */
  subscribeLifecycle(listener: (event: BrowserLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
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

  /** Observes leased worker tabs and validates their current snapshots at the browser boundary. */
  async observeWorkerTabs(afterRevisionByTab: ReadonlyMap<number, number>): Promise<WorkerTabObservation | undefined> {
    let response: unknown;
    try {
      response = await this.request<unknown>("list_tabs");
    } catch {
      return undefined;
    }
    if (!response || typeof response !== "object") return undefined;
    const tabs = (response as { tabs?: unknown }).tabs;
    if (!Array.isArray(tabs)) return undefined;

    const tabIds = new Set<number>();
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object") return undefined;
      const tabId = (tab as { tabId?: unknown }).tabId;
      if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId <= 0) return undefined;
      tabIds.add(tabId);
    }

    const snapshots = new Map<number, ChatGptWorkerSnapshot>();
    for (const [tabId, afterRevision] of afterRevisionByTab) {
      if (!tabIds.has(tabId)) continue;
      const cached = this.chatGptWorkerSnapshots.get(tabId);
      if (cached) snapshots.set(tabId, { ...cached });

      try {
        const current = await this.request<{ snapshot?: unknown }>("read_chatgpt_worker_snapshot", {
          tabId,
          afterRevision: Number.isSafeInteger(afterRevision) && afterRevision >= 0 ? afterRevision : 0,
        });
        const snapshot = validChatGptWorkerSnapshot(current?.snapshot);
        const remembered = snapshot ? this.rememberChatGptWorkerSnapshot(tabId, snapshot) : undefined;
        const latest = snapshots.get(tabId);
        if (remembered && (!latest || remembered.revision > latest.revision)) {
          snapshots.set(tabId, { ...remembered });
        }
      } catch (error) {
        if (error instanceof BrowserError && error.code === "TAB_NOT_FOUND") {
          tabIds.delete(tabId);
          continue;
        }
        // An unrelated individual snapshot failure is inconclusive; the tab listing remains usable.
      }
    }
    return { tabIds, snapshots };
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
      this.emitLifecycle({
        type: "ready",
        extensionVersion: message.extensionVersion,
        extensionId: message.extensionId,
      });
      return;
    }
    if (message.type === "event") {
      const event = this.validLifecycleEvent(message);
      if (event) this.emitLifecycle(event);
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

  /** Validates one bounded native event and normalizes it for lifecycle consumers. */
  private validLifecycleEvent(message: IncomingNativeMessage): BrowserLifecycleEvent | undefined {
    if (message.type !== "event") return undefined;
    if (message.event === "agent_worker_tab_removed") {
      if (!Number.isSafeInteger(message.tabId) || message.tabId <= 0) return undefined;
      const cached = this.chatGptWorkerSnapshots.get(message.tabId);
      this.chatGptWorkerSnapshots.delete(message.tabId);
      return cached && completedWorkerMarker(cached)
        ? { type: "agent_worker_tab_removed", tabId: message.tabId, snapshot: { ...cached } }
        : { type: "agent_worker_tab_removed", tabId: message.tabId };
    }
    return this.cacheChatGptWorkerSnapshot(message);
  }

  /** Caches one newer bounded snapshot and returns lifecycle evidence without regressing current-turn completion. */
  private cacheChatGptWorkerSnapshot(message: IncomingNativeMessage): BrowserLifecycleEvent | undefined {
    if (
      message.type !== "event" ||
      message.event !== "chatgpt_worker_snapshot" ||
      !Number.isSafeInteger(message.tabId) ||
      message.tabId <= 0
    ) {
      return undefined;
    }
    const snapshot = validChatGptWorkerSnapshot(message.snapshot);
    if (!snapshot) return undefined;
    const cached = this.rememberChatGptWorkerSnapshot(message.tabId, snapshot);
    if (!cached) return undefined;
    return { type: "chatgpt_worker_snapshot", tabId: message.tabId, snapshot: { ...cached } };
  }

  /** Retains one newer validated snapshot without emitting a lifecycle event. */
  private rememberChatGptWorkerSnapshot(
    tabId: number,
    snapshot: ChatGptWorkerSnapshot,
  ): ChatGptWorkerSnapshot | undefined {
    const current = this.chatGptWorkerSnapshots.get(tabId);
    if (current && snapshot.revision <= current.revision) return undefined;
    const cached = current ? preserveCompletedWorkerEvidence(current, snapshot) : snapshot;
    this.chatGptWorkerSnapshots.set(tabId, cached);
    return cached;
  }

  /** Delivers one lifecycle event without allowing observers to mutate cached evidence or disrupt parsing. */
  private emitLifecycle(event: BrowserLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      const delivered =
        event.type === "chatgpt_worker_snapshot"
          ? { ...event, snapshot: { ...event.snapshot } }
          : { ...event };
      try {
        listener(delivered);
      } catch {
        // A lifecycle observer cannot be allowed to disrupt Native Messaging protocol handling.
      }
    }
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
