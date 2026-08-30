// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatGptWorkerCommand } from "../../src/extension/chatgptWorker.js";

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
      latestAssistantText: "first line\n\nsecond line\n<<<SUBAGENT_DONE:abc>>>",
    });
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
