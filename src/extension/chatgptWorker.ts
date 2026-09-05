export type ChatGptWorkerCommand =
  | { action: "submit"; prompt: string; tabId?: number }
  | { action: "read" }
  | { action: "snapshot"; tabId: number };

// This function is injected with chrome.scripting.executeScript, so it must remain self-contained.
/** Submits a worker prompt or reads the exact bounded state of the latest ChatGPT exchange. */
export function runChatGptWorkerCommand(command: ChatGptWorkerCommand) {
  const composerSelector = "#prompt-textarea";
  const sendSelector = 'button[data-testid="send-button"], #composer-submit-button';
  const userMessageSelector = '[data-message-author-role="user"]';
  const assistantMessageSelector = '[data-message-author-role="assistant"]';
  const generatingSelector =
    'button[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label="Stop"], #composer-submit-button[aria-label*="Stop"]';
  const maxAssistantCharacters = 30_000;
  const maxUserCharacters = 110_000;
  const truncationNotice = "\n\n[Worker output truncated for safety]\n\n";
  const completionMarkerTailCharacters = 1_024;
  const completionMarkerPattern = /<<<SUBAGENT_DONE\s*:\s*([A-Za-z0-9_-]+(?:\s*-\s*[A-Za-z0-9_-]+)*)\s*>>>/g;
  const snapshotPublishDelayMilliseconds = 50;
  type Snapshot = {
    ready: boolean;
    generating: boolean;
    latestUserText: string | null;
    latestUserTruncated: boolean;
    latestAssistantText: string | null;
    latestAssistantTruncated: boolean;
    revision: number;
    timestamp: number;
  };
  type ObserverState = {
    tabId: number;
    observer: MutationObserver;
    snapshot?: Snapshot;
    pendingPublish?: ReturnType<typeof setTimeout>;
  };
  const observerHost = globalThis as typeof globalThis & {
    __chromeBrowserMcpChatGptWorkerObserver?: ObserverState;
  };

  /** Reads all outermost message-content blocks in display order without duplicating nested markup. */
  const exactMessageText = (element: Element | undefined): string | null => {
    if (!element) return null;
    const findCompletionMarker = (value: string | undefined): string | undefined => {
      if (typeof value !== "string") return undefined;
      const matches = Array.from(value.matchAll(completionMarkerPattern));
      const payload = matches.at(-1)?.[1];
      return payload ? `<<<SUBAGENT_DONE:${payload.replace(/\s+/g, "")}>>>` : undefined;
    };
    const markerFromFollowingSiblings = (node: Element): string | undefined => {
      let current: Element | null = node;
      for (let depth = 0; current && depth < 6; depth += 1) {
        let sibling: ChildNode | null = current.nextSibling;
        while (sibling) {
          const siblingText =
            sibling instanceof HTMLElement && typeof sibling.innerText === "string"
              ? sibling.innerText
              : sibling.textContent ?? "";
          const marker = findCompletionMarker(siblingText);
          if (marker) return marker;
          sibling = sibling.nextSibling;
        }
        current = current.parentElement;
      }
      return undefined;
    };
    const contentSelector = ".markdown, [data-message-content]";
    const candidates = [
      ...(element.matches(contentSelector) ? [element] : []),
      ...Array.from(element.querySelectorAll(contentSelector)),
    ];
    const blocks = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
    const textBlocks = blocks.length > 0 ? blocks : [element];
    const text = textBlocks
      .map((block) => {
        const html = block as HTMLElement;
        return typeof html.innerText === "string" ? html.innerText : block.textContent ?? "";
      })
      .join("\n\n");
    const renderedText = (element as HTMLElement).innerText;
    const marker = element.matches(assistantMessageSelector)
      ? findCompletionMarker(renderedText) ?? markerFromFollowingSiblings(element)
      : undefined;
    if (marker && !text.includes(marker)) return text ? `${text}\n\n${marker}` : marker;
    return text;
  };

  /** Caps browser-derived assistant text while retaining its final protocol marker in the suffix. */
  const boundedAssistantText = (text: string | null) => {
    if (text === null || text.length <= maxAssistantCharacters) return { text, truncated: false as const };
    const suffixLength = Math.min(completionMarkerTailCharacters, maxAssistantCharacters - truncationNotice.length);
    const prefixLength = maxAssistantCharacters - truncationNotice.length - suffixLength;
    return {
      text: `${text.slice(0, prefixLength)}${truncationNotice}${text.slice(-suffixLength)}`,
      truncated: true as const,
    };
  };

  /** Caps the echoed user message above the public prompt limit so identity checks remain exact. */
  const boundedUserText = (text: string | null) => {
    if (text === null || text.length <= maxUserCharacters) return { text, truncated: false as const };
    return { text: text.slice(0, maxUserCharacters), truncated: true as const };
  };

  /** Reads composer readiness without retaining any page objects between invocations. */
  const pageState = () => {
    const composer = document.querySelector(composerSelector);
    const ready =
      composer instanceof HTMLElement &&
      !("disabled" in composer && Boolean((composer as HTMLInputElement).disabled)) &&
      !("readOnly" in composer && Boolean((composer as HTMLInputElement).readOnly));
    return { composer, ready };
  };

  /** Finds the last removed message node so a same-batch virtualization can still be captured. */
  const latestRemovedMessage = (records: MutationRecord[], selector: string): Element | undefined => {
    const candidates: Element[] = [];
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector)) candidates.push(node);
        candidates.push(...Array.from(node.querySelectorAll(selector)));
      }
    }
    return candidates.at(-1);
  };

  /** Captures current page state, preserving previously seen turn text after DOM virtualization. */
  const captureSnapshot = (previous?: Snapshot, records: MutationRecord[] = []): Snapshot => {
    const userMessages = Array.from(document.querySelectorAll(userMessageSelector));
    const assistantMessages = Array.from(document.querySelectorAll(assistantMessageSelector));
    const user = boundedUserText(
      exactMessageText(userMessages.at(-1)) ?? exactMessageText(latestRemovedMessage(records, userMessageSelector)),
    );
    const assistant = boundedAssistantText(
      exactMessageText(assistantMessages.at(-1)) ??
        exactMessageText(latestRemovedMessage(records, assistantMessageSelector)),
    );
    const page = pageState();
    return {
      ready: page.ready,
      generating: document.querySelector(generatingSelector) !== null,
      latestUserText: user.text ?? previous?.latestUserText ?? null,
      latestUserTruncated: user.text === null ? previous?.latestUserTruncated ?? false : user.truncated,
      latestAssistantText: assistant.text ?? previous?.latestAssistantText ?? null,
      latestAssistantTruncated: assistant.text === null ? previous?.latestAssistantTruncated ?? false : assistant.truncated,
      revision: (previous?.revision ?? 0) + 1,
      timestamp: Math.max(1, Date.now(), (previous?.timestamp ?? 0) + 1),
    };
  };

  /** Sends one already-captured bounded snapshot through the extension event channel. */
  const sendSnapshot = (state: ObserverState, snapshot: Snapshot): void => {
    try {
      const pending: unknown = chrome.runtime.sendMessage({ type: "chatgpt_worker_snapshot", tabId: state.tabId, snapshot });
      if (pending && typeof (pending as { then?: unknown }).then === "function") {
        void (pending as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // Snapshot delivery is best effort; the page-local copy remains available to a later read.
    }
  };

  /** Captures and sends one current bounded snapshot immediately. */
  const publishSnapshot = (state: ObserverState): Snapshot => {
    const snapshot = captureSnapshot(state.snapshot);
    state.snapshot = snapshot;
    sendSnapshot(state, snapshot);
    return snapshot;
  };

  /** Starts one page-local observer and returns its latest bounded snapshot. */
  const observe = (tabId: number, refresh = false): Snapshot => {
    const existing = observerHost.__chromeBrowserMcpChatGptWorkerObserver;
    if (existing?.tabId === tabId && existing.snapshot) {
      if (!refresh) return existing.snapshot;
      if (existing.pendingPublish !== undefined) {
        clearTimeout(existing.pendingPublish);
        existing.pendingPublish = undefined;
      }
      return publishSnapshot(existing);
    }
    existing?.observer.disconnect();
    if (existing?.pendingPublish !== undefined) clearTimeout(existing.pendingPublish);

    const state: ObserverState = { tabId, observer: undefined as unknown as MutationObserver };
    /** Defers one snapshot so rapid DOM changes share one bounded native event. */
    const schedulePublish = (records: MutationRecord[]) => {
      state.snapshot = captureSnapshot(state.snapshot, records);
      if (state.pendingPublish !== undefined) return;
      state.pendingPublish = setTimeout(() => {
        state.pendingPublish = undefined;
        if (typeof document !== "undefined" && typeof chrome !== "undefined") publishSnapshot(state);
      }, snapshotPublishDelayMilliseconds);
    };
    state.observer = new MutationObserver((records) => {
      if (typeof document === "undefined" || typeof chrome === "undefined") return;
      schedulePublish(records);
    });
    observerHost.__chromeBrowserMcpChatGptWorkerObserver = state;
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-disabled",
        "class",
        "contenteditable",
        "data-message-author-role",
        "data-testid",
        "disabled",
        "hidden",
        "readonly",
        "style",
      ],
    });
    return publishSnapshot(state);
  };

  if (command.action === "snapshot") return { snapshot: observe(command.tabId, true) };

  const { composer, ready } = pageState();

  if (command.action === "submit") {
    const snapshot = command.tabId === undefined ? undefined : observe(command.tabId);
    const existingUsers = Array.from(document.querySelectorAll(userMessageSelector));
    if (exactMessageText(existingUsers.at(-1)) === command.prompt) {
      return snapshot === undefined ? { submitted: true as const } : { submitted: true as const, snapshot };
    }
    if (!ready || !(composer instanceof HTMLElement)) {
      throw new Error("CHATGPT_NOT_READY: composer is not ready");
    }

    if (composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement) {
      const prototype =
        composer instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(composer, command.prompt);
      else composer.value = command.prompt;
    } else if (composer.isContentEditable || composer.getAttribute("contenteditable") === "true") {
      composer.textContent = command.prompt;
    } else {
      throw new Error("CHATGPT_NOT_READY: composer is not editable");
    }

    composer.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const sendButton = document.querySelector(sendSelector);
    if (!(sendButton instanceof HTMLButtonElement) || sendButton.disabled) {
      throw new Error("CHATGPT_NOT_READY: send button is not ready");
    }
    sendButton.click();
    return snapshot === undefined ? { submitted: true as const } : { submitted: true as const, snapshot };
  }

  const userMessages = Array.from(document.querySelectorAll(userMessageSelector));
  const assistantMessages = Array.from(document.querySelectorAll(assistantMessageSelector));
  const user = boundedUserText(exactMessageText(userMessages.at(-1)));
  const assistant = boundedAssistantText(exactMessageText(assistantMessages.at(-1)));
  return { ready, generating: document.querySelector(generatingSelector) !== null, latestUserText: user.text, latestUserTruncated: user.truncated, latestAssistantText: assistant.text, latestAssistantTruncated: assistant.truncated };
}
