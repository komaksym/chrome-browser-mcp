export type ChatGptWorkerCommand =
  | { action: "submit"; prompt: string }
  | { action: "read" };

// This function is injected with chrome.scripting.executeScript, so it must remain self-contained.
/** Submits a worker prompt or reads the exact bounded state of the latest ChatGPT exchange. */
export function runChatGptWorkerCommand(command: ChatGptWorkerCommand) {
  const composerSelector = "#prompt-textarea";
  const sendSelector = 'button[data-testid="send-button"]';
  const userMessageSelector = '[data-message-author-role="user"]';
  const assistantMessageSelector = '[data-message-author-role="assistant"]';
  const generatingSelector =
    'button[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label="Stop"]';
  const maxAssistantCharacters = 30_000;
  const maxUserCharacters = 110_000;
  const truncationNotice = "\n\n[Worker output truncated for safety]\n\n";
  const completionMarkerTailCharacters = 1_024;

  /** Reads all outermost message-content blocks in display order without duplicating nested markup. */
  const exactMessageText = (element: Element | undefined): string | null => {
    if (!element) return null;
    const contentSelector = ".markdown, [data-message-content]";
    const candidates = [
      ...(element.matches(contentSelector) ? [element] : []),
      ...Array.from(element.querySelectorAll(contentSelector)),
    ];
    const blocks = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
    const textBlocks = blocks.length > 0 ? blocks : [element];
    return textBlocks
      .map((block) => {
        const html = block as HTMLElement;
        return typeof html.innerText === "string" ? html.innerText : block.textContent ?? "";
      })
      .join("\n\n");
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

  const composer = document.querySelector(composerSelector);
  const ready =
    composer instanceof HTMLElement &&
    !("disabled" in composer && Boolean((composer as HTMLInputElement).disabled)) &&
    !("readOnly" in composer && Boolean((composer as HTMLInputElement).readOnly));

  if (command.action === "submit") {
    const existingUsers = Array.from(document.querySelectorAll(userMessageSelector));
    if (exactMessageText(existingUsers.at(-1)) === command.prompt) return { submitted: true as const };
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
    return { submitted: true as const };
  }

  const userMessages = Array.from(document.querySelectorAll(userMessageSelector));
  const assistantMessages = Array.from(document.querySelectorAll(assistantMessageSelector));
  const user = boundedUserText(exactMessageText(userMessages.at(-1)));
  const assistant = boundedAssistantText(exactMessageText(assistantMessages.at(-1)));
  return {
    ready,
    generating: document.querySelector(generatingSelector) !== null,
    latestUserText: user.text,
    latestUserTruncated: user.truncated,
    latestAssistantText: assistant.text,
    latestAssistantTruncated: assistant.truncated,
  };
}
