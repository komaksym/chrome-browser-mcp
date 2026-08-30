export type ChatGptWorkerCommand =
  | { action: "submit"; prompt: string }
  | { action: "read" };

// This function is injected with chrome.scripting.executeScript, so it must remain self-contained.
export function runChatGptWorkerCommand(command: ChatGptWorkerCommand) {
  const composerSelector = "#prompt-textarea";
  const sendSelector = 'button[data-testid="send-button"]';
  const userMessageSelector = '[data-message-author-role="user"]';
  const assistantMessageSelector = '[data-message-author-role="assistant"]';
  const generatingSelector =
    'button[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label="Stop"]';

  const exactMessageText = (element: Element | undefined): string | null => {
    if (!element) return null;
    const body = element.querySelector(".markdown, [data-message-content]") ?? element;
    const html = body as HTMLElement;
    return typeof html.innerText === "string" ? html.innerText : body.textContent ?? "";
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
  return {
    ready,
    generating: document.querySelector(generatingSelector) !== null,
    latestUserText: exactMessageText(userMessages.at(-1)),
    latestAssistantText: exactMessageText(assistantMessages.at(-1)),
  };
}
