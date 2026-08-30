// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatGptWorkerCommand } from "../../src/extension/chatgptWorker.js";

/** Assigns visible text in JSDOM, which does not calculate it from layout. */
function withInnerText(element: Element, text: string): void {
  Object.defineProperty(element, "innerText", { configurable: true, value: text });
}

describe("ChatGPT worker extension command", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads only the latest worker messages and preserves assistant text", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
    `;
    const users = document.querySelectorAll('[data-message-author-role="user"]');
    const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
    withInnerText(users[0]!, "old task");
    withInnerText(assistants[0]!, "old answer");
    withInnerText(users[1]!, "RUN_ID: R42\nTASK_ID: task-2");
    withInnerText(assistants[1]!, "first line\n\nsecond line\n<<<SUBAGENT_DONE:abc>>>");

    const result = runChatGptWorkerCommand({ action: "read" });

    expect(result).toEqual({
      ready: true,
      generating: false,
      latestUserText: "RUN_ID: R42\nTASK_ID: task-2",
      latestUserTruncated: false,
      latestAssistantText: "first line\n\nsecond line\n<<<SUBAGENT_DONE:abc>>>",
      latestAssistantTruncated: false,
    });
  });

  it("bounds an oversized latest user message before native-message serialization", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
    `;
    withInnerText(document.querySelector('[data-message-author-role="user"]')!, "u".repeat(120_000));

    const result = runChatGptWorkerCommand({ action: "read" });

    expect(result).toMatchObject({ latestUserTruncated: true });
    expect(result.latestUserText).toHaveLength(110_000);
  });

  it("reads every content block from the latest assistant message in display order", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant">
        <div class="markdown"></div>
        <div class="markdown"></div>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const blocks = document.querySelectorAll('[data-message-author-role="assistant"] .markdown');
    withInnerText(user, "worker task");
    withInnerText(blocks[0]!, "first block");
    withInnerText(blocks[1]!, "second block\n<<<SUBAGENT_DONE:complete>>>");

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: "first block\n\nsecond block\n<<<SUBAGENT_DONE:complete>>>",
      latestAssistantTruncated: false,
    });
  });

  it("bounds worker output while retaining its final completion marker", () => {
    const marker = "<<<SUBAGENT_DONE:bounded>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"><div class="markdown"></div></div>
    `;
    withInnerText(document.querySelector('[data-message-author-role="user"]')!, "worker task");
    withInnerText(
      document.querySelector('[data-message-author-role="assistant"] .markdown')!,
      `${"x".repeat(40_000)}\n${marker}`,
    );

    const result = runChatGptWorkerCommand({ action: "read" });

    expect(result).toMatchObject({ latestAssistantTruncated: true });
    expect(result.latestAssistantText?.length).toBeLessThanOrEqual(30_000);
    expect(result.latestAssistantText).toContain("[Worker output truncated for safety]");
    expect(result.latestAssistantText?.endsWith(marker)).toBe(true);
  });

  it("reports generation while ChatGPT exposes its stop control", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="stop-button">Stop</button>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
    `;
    withInnerText(document.querySelector('[data-message-author-role="user"]')!, "task");
    withInnerText(document.querySelector('[data-message-author-role="assistant"]')!, "partial");

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      ready: true,
      generating: true,
      latestAssistantText: "partial",
      latestAssistantTruncated: false,
    });
  });

  it("submits through the worker command without exposing selector choreography to the caller", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    `;
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    const input = vi.fn();
    const clicked = vi.fn();
    composer.addEventListener("input", input);
    send.addEventListener("click", clicked);

    expect(runChatGptWorkerCommand({ action: "submit", prompt: "worker task" })).toEqual({
      submitted: true,
    });
    expect(composer.textContent).toBe("worker task");
    expect(input).toHaveBeenCalledOnce();
    expect(clicked).toHaveBeenCalledOnce();
  });
});
