// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatGptWorkerCommand } from "../../src/extension/chatgptWorker.js";

/** Assigns visible text in JSDOM, which does not calculate it from layout. */
function withInnerText(element: Element, text: string): void {
  Object.defineProperty(element, "innerText", { configurable: true, value: text });
}

type SnapshotMessage = {
  type: "chatgpt_worker_snapshot";
  tabId: number;
  snapshot: {
    ready: boolean;
    generating: boolean;
    latestUserText: string | null;
    latestUserTruncated: boolean;
    latestAssistantText: string | null;
    latestAssistantTruncated: boolean;
    rateLimited?: boolean;
    revision: number;
    timestamp: number;
  };
};

/** Captures messages sent from the injected command without mocking its DOM behavior. */
function captureSnapshotMessages(): SnapshotMessage[] {
  const messages: SnapshotMessage[] = [];
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: (message: SnapshotMessage) => {
        messages.push(message);
        return Promise.resolve();
      },
    },
  });
  return messages;
}

/** Waits for the worker's bounded debounce window and its MutationObserver callback. */
function waitForSnapshotFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

describe("ChatGPT worker extension command", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });
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
      rateLimited: false,
    });
  });

  it("reports a visible rate-limit modal as structured worker UI state", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
      <div role="dialog" aria-modal="true">
        <p>You’re making requests too quickly.</p>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    withInnerText(user, "worker task");
    withInnerText(assistant, "A report that mentions too many requests is still data.");

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: "A report that mentions too many requests is still data.",
      rateLimited: true,
    });
  });

  it("does not infer rate limiting from assistant response prose", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    withInnerText(user, "worker task");
    withInnerText(assistant, "A report that mentions too many requests is still data.");

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({ rateLimited: false });
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

  it("retains a completion marker rendered beside the assistant content block", () => {
    const marker = "<<<SUBAGENT_DONE:sibling>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant">
        <div class="markdown"></div>
        <div class="plain-text-marker"></div>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    const markerNode = assistant.querySelector(".plain-text-marker")!;
    withInnerText(user, "worker task");
    withInnerText(content, "useful response");
    withInnerText(markerNode, marker);
    withInnerText(assistant, `useful response\n${marker}`);

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: `useful response\n\n${marker}`,
      latestAssistantTruncated: false,
    });
  });

  it("does not associate a marker rendered after the assistant message", () => {
    const marker = "<<<SUBAGENT_DONE:sibling-outside>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div class="turn">
        <div data-message-author-role="assistant"><div class="markdown"></div></div>
        <div class="plain-text-marker"></div>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    const markerNode = document.querySelector(".plain-text-marker")!;
    withInnerText(user, "worker task");
    withInnerText(content, "useful response");
    withInnerText(assistant, "useful response");
    withInnerText(markerNode, marker);

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: "useful response",
      latestAssistantTruncated: false,
    });
  });

  it("retains a completion marker from DOM text when rendered text omits it", () => {
    const marker = "<<<SUBAGENT_DONE:dom-text>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant">
        <div class="markdown"></div>
        <span class="protocol-marker"></span>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    const markerNode = assistant.querySelector(".protocol-marker")!;
    withInnerText(user, "worker task");
    withInnerText(content, "useful response");
    withInnerText(assistant, "useful response");
    markerNode.textContent = marker;

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: `useful response\n\n${marker}`,
      latestAssistantTruncated: false,
    });
  });

  it("uses complete DOM text when rendered text exposes the marker before it settles", () => {
    const marker = "<<<SUBAGENT_DONE:stable-dom>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div class="protocol-portal"></div>
      <div data-message-author-role="assistant"><div class="markdown"></div></div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    document.querySelector(".protocol-portal")!.textContent = marker;
    withInnerText(user, "worker task");
    content.textContent = `Complete response\n${marker}`;
    withInnerText(content, `Partial response\n${marker}`);
    withInnerText(assistant, `Partial response\n${marker}`);

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: `Complete response\n${marker}`,
      latestAssistantTruncated: false,
    });
  });

  it("uses DOM text only for the response block carrying the settled marker", () => {
    const marker = "<<<SUBAGENT_DONE:scoped-dom>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant">
        <div class="markdown" id="response-block"></div>
        <div class="markdown" id="secondary-block"></div>
      </div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const responseBlock = document.querySelector("#response-block")!;
    const secondaryBlock = document.querySelector("#secondary-block")!;
    withInnerText(user, "worker task");
    responseBlock.textContent = `Complete response\n${marker}`;
    withInnerText(responseBlock, `Partial response\n${marker}`);
    secondaryBlock.textContent = "Hidden control label";
    withInnerText(secondaryBlock, "Rendered secondary response");
    withInnerText(assistant, `Partial response\n${marker}\nRendered secondary response`);

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: `Complete response\n${marker}\n\nRendered secondary response`,
      latestAssistantTruncated: false,
    });
  });

  it("does not treat the dispatched prompt marker as a completed worker response", () => {
    const marker = "<<<SUBAGENT_DONE:prompt-text>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div class="protocol-portal"></div>
      <div data-message-author-role="assistant"><div class="markdown"></div></div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    document.querySelector(".protocol-portal")!.textContent = marker;
    withInnerText(user, `worker task\n${marker}`);
    withInnerText(content, "useful response");
    withInnerText(assistant, "useful response");

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: "useful response",
      latestAssistantTruncated: false,
    });
  });

  it("does not accept a duplicated prompt marker from a document-level response region", () => {
    const marker = "<<<SUBAGENT_DONE:document-portal>>>";
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"><div class="markdown"></div></div>
      <div class="protocol-portal"></div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    const content = assistant.querySelector(".markdown")!;
    const portal = document.querySelector(".protocol-portal")!;
    user.textContent = `worker task\n${marker}`;
    withInnerText(user, `worker task\n${marker}`);
    withInnerText(content, "useful response");
    withInnerText(assistant, "useful response");
    portal.textContent = marker;

    expect(runChatGptWorkerCommand({ action: "read" })).toMatchObject({
      latestAssistantText: "useful response",
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

  it("reports generation while ChatGPT reuses its composer button as stop control", () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button" aria-label="Stop answering">Stop</button>
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

  it("submits through the worker command without exposing selector choreography to the caller", async () => {
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

    expect(await runChatGptWorkerCommand({ action: "submit", prompt: "worker task" })).toEqual({
      submitted: true,
    });
    expect(composer.textContent).toBe("worker task");
    expect(input).toHaveBeenCalledOnce();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("submits through ChatGPT's current composer control", async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button">Send</button>
    `;
    const send = document.querySelector<HTMLButtonElement>("#composer-submit-button")!;
    const clicked = vi.fn();
    send.addEventListener("click", clicked);

    expect(await runChatGptWorkerCommand({ action: "submit", prompt: "worker task" })).toEqual({
      submitted: true,
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("waits for the controlled composer state to commit before clicking", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      `;
      const send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
      const clicked = vi.fn();
      send.addEventListener("click", clicked);

      const result = runChatGptWorkerCommand({ action: "submit", prompt: "worker task" });

      expect(clicked).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(49);
      expect(clicked).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ submitted: true });
      expect(clicked).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the page action input contract for a controlled contenteditable composer", async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true">old text</div>
      <button data-testid="send-button">Send</button>
    `;
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const input = vi.fn();
    const change = vi.fn();
    composer.addEventListener("input", input);
    composer.addEventListener("change", change);

    expect(await runChatGptWorkerCommand({ action: "submit", prompt: "worker task" })).toMatchObject({
      submitted: true,
    });
    expect(composer.textContent).toBe("worker task");
    expect(input).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledOnce();
  });

  it("skips a disabled legacy composer control when the current send control is available", async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button" disabled>Legacy send</button>
      <button id="composer-submit-button">Send</button>
    `;
    const send = document.querySelector<HTMLButtonElement>("#composer-submit-button")!;
    const clicked = vi.fn();
    send.addEventListener("click", clicked);

    expect(await runChatGptWorkerCommand({ action: "submit", prompt: "worker task" })).toEqual({
      submitted: true,
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("publishes incremental assistant snapshots when observation starts with submission", async () => {
    const messages = captureSnapshotMessages();
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    `;
    const send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    send.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div data-message-author-role="user"></div><div data-message-author-role="assistant"><div class="markdown"></div></div>',
      );
      withInnerText(document.querySelector('[data-message-author-role="user"]')!, "worker task");
      withInnerText(document.querySelector('[data-message-author-role="assistant"] .markdown')!, "partial one");
    });

    const result = await runChatGptWorkerCommand({ action: "submit", prompt: "worker task", tabId: 701 });
    await waitForSnapshotFlush();
    const first = messages.filter((message) => message.tabId === 701).at(-1);

    const partial = document.querySelector('[data-message-author-role="assistant"] .markdown')!;
    withInnerText(partial, "partial two");
    partial.append(document.createTextNode(""));
    await waitForSnapshotFlush();
    const second = messages.filter((message) => message.tabId === 701).at(-1);

    expect(result).toMatchObject({ submitted: true });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected observer snapshots for the submitted worker turn");
    expect(first).toMatchObject({
      type: "chatgpt_worker_snapshot",
      tabId: 701,
      snapshot: {
        ready: true,
        generating: false,
        latestUserText: "worker task",
        latestAssistantText: "partial one",
      },
    });
    expect(Number.isInteger(first.snapshot.revision)).toBe(true);
    expect(first.snapshot.revision).toBeGreaterThan(0);
    expect(Number.isInteger(first.snapshot.timestamp)).toBe(true);
    expect(first.snapshot.timestamp).toBeGreaterThan(0);
    expect(second.snapshot).toMatchObject({ latestAssistantText: "partial two" });
    expect(second.snapshot.revision).toBeGreaterThan(first.snapshot.revision);
    expect(second.snapshot.timestamp).toBeGreaterThan(first.snapshot.timestamp);
  });

  it("publishes a marker-preserving truncated observer snapshot", () => {
    const messages = captureSnapshotMessages();
    const marker = "<<<SUBAGENT_DONE:observer-bounded>>>";
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

    const result = runChatGptWorkerCommand({ action: "snapshot", tabId: 702 });
    const snapshot = result.snapshot;
    const published = messages.find((message) => message.tabId === 702);

    if (!snapshot) throw new Error("Expected a worker snapshot");
    expect(snapshot).toMatchObject({
      latestAssistantTruncated: true,
    });
    expect(snapshot.latestAssistantText).toHaveLength(30_000);
    expect(snapshot.latestAssistantText?.endsWith(marker)).toBe(true);
    expect(published).toBeDefined();
    if (!published) throw new Error("Expected the initial observer snapshot to be published");
    expect(published).toMatchObject({
      type: "chatgpt_worker_snapshot",
      tabId: 702,
      snapshot: { latestAssistantText: snapshot.latestAssistantText },
    });
  });

  it("retains captured turn evidence when message nodes are virtualized away", async () => {
    const messages = captureSnapshotMessages();
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user"></div>
      <div data-message-author-role="assistant"></div>
    `;
    const user = document.querySelector('[data-message-author-role="user"]')!;
    const assistant = document.querySelector('[data-message-author-role="assistant"]')!;
    withInnerText(user, "worker task");
    withInnerText(assistant, "captured answer\n<<<SUBAGENT_DONE:captured>>>");

    runChatGptWorkerCommand({ action: "snapshot", tabId: 703 });
    user.remove();
    assistant.remove();
    await waitForSnapshotFlush();
    const snapshot = messages.filter((message) => message.tabId === 703).at(-1)?.snapshot;

    expect(snapshot).toMatchObject({
      latestUserText: "worker task",
      latestAssistantText: "captured answer\n<<<SUBAGENT_DONE:captured>>>",
    });
  });

  it("coalesces rapid DOM changes into one delayed snapshot", async () => {
    const messages = captureSnapshotMessages();
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="assistant"><div class="markdown"></div></div>
    `;
    const assistant = document.querySelector('[data-message-author-role="assistant"] .markdown')!;

    runChatGptWorkerCommand({ action: "snapshot", tabId: 704 });
    assistant.textContent = "partial one";
    assistant.textContent = "partial two";
    await Promise.resolve();

    expect(messages.filter((message) => message.tabId === 704)).toHaveLength(1);
    await waitForSnapshotFlush();

    const snapshots = messages.filter((message) => message.tabId === 704);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)?.snapshot.latestAssistantText).toBe("partial two");
  });

  it("captures rendered content before virtualization removes it during the flush window", async () => {
    const messages = captureSnapshotMessages();
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';

    runChatGptWorkerCommand({ action: "snapshot", tabId: 705 });
    const assistant = document.createElement("div");
    assistant.dataset.messageAuthorRole = "assistant";
    assistant.textContent = "captured before removal\n<<<SUBAGENT_DONE:early>>>";
    document.body.append(assistant);
    await Promise.resolve();
    assistant.remove();
    await waitForSnapshotFlush();

    expect(messages.filter((message) => message.tabId === 705).at(-1)?.snapshot.latestAssistantText).toBe(
      "captured before removal\n<<<SUBAGENT_DONE:early>>>",
    );
  });

  it("captures a message that is added and virtualized in one mutation batch", async () => {
    const messages = captureSnapshotMessages();
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';

    runChatGptWorkerCommand({ action: "snapshot", tabId: 706 });
    const assistant = document.createElement("div");
    assistant.dataset.messageAuthorRole = "assistant";
    assistant.textContent = "captured from removal\n<<<SUBAGENT_DONE:batch>>>";
    document.body.append(assistant);
    assistant.remove();
    await waitForSnapshotFlush();

    expect(messages.filter((message) => message.tabId === 706).at(-1)?.snapshot.latestAssistantText).toBe(
      "captured from removal\n<<<SUBAGENT_DONE:batch>>>",
    );
  });
});
