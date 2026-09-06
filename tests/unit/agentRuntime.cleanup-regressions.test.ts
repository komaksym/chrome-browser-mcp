import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/bridge/agentRuntime.js";
import { BrowserError, type BrowserClient } from "../../src/bridge/browserClient.js";
import { createRecoveryBrowser } from "./recoveryBrowserFixture.js";

/** Extracts the unique protocol marker from a submitted worker prompt. */
function completionMarker(prompt: string): string {
  const marker = prompt.match(/<<<SUBAGENT_DONE:[0-9a-f-]+>>>/i)?.[0];
  if (!marker) throw new Error(`Missing completion marker in prompt: ${prompt}`);
  return marker;
}

describe("AgentRuntime cleanup regressions", () => {
  it("makes the completion marker contract override a task's one-line format", async () => {
    let submittedPrompt = "";
    const browser = {
      request: (method: string, args: Record<string, unknown> = {}) => {
        if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
        if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
        if (method === "chatgpt_worker_submit") {
          submittedPrompt = args.prompt as string;
          return Promise.resolve({ submitted: true });
        }
        return Promise.resolve({});
      },
    } as BrowserClient;
    const runtime = new AgentRuntime(browser);

    await runtime.spawnAgents([{ agent_id: "format", prompt: "Return exactly one line." }], 1);

    const marker = completionMarker(submittedPrompt);
    expect(submittedPrompt).toContain("The task's output-format rules apply to the report only.");
    expect(submittedPrompt).toContain("Output the report first, then on a new final line output exactly the completion marker below.");
    expect(submittedPrompt).toContain(`Completion marker: ${marker}`);
  });

  it("caps worker submission retries at 20 attempts", async () => {
    vi.useFakeTimers();
    try {
      let submissionAttempts = 0;
      const browser = {
        request: (method: string) => {
          if (method === "resolve_chatgpt_anchor") return Promise.resolve({ tab: { tabId: 9000, windowId: 42 } });
          if (method === "open_agent_worker_tab") return Promise.resolve({ tab: { tabId: 1 } });
          if (method === "chatgpt_worker_submit") {
            submissionAttempts += 1;
            return Promise.reject(new BrowserError("NAVIGATION_IN_PROGRESS", "worker tab is still navigating"));
          }
          if (method === "read_chatgpt_worker") {
            return Promise.resolve({
              ready: false,
              generating: false,
              latestUserText: null,
              latestAssistantText: null,
            });
          }
          return Promise.resolve({});
        },
      } as unknown as BrowserClient;
      const runtime = new AgentRuntime(browser);

      const spawning = runtime.spawnAgents([{ agent_id: "submission-cap", prompt: "answer once" }], 1);
      await vi.runAllTimersAsync();
      const spawned = await spawning;

      expect(submissionAttempts).toBe(20);
      expect(spawned).toMatchObject({
        state: "RUNNING",
        jobs: [{
          agent_id: "submission-cap",
          state: "FAILED_TRANSIENT",
          terminal: false,
          recoverable: true,
          error: { code: "NAVIGATION_IN_PROGRESS", retryable: true },
        }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads only a definitely finished worker and recovers without resubmission", async () => {
    const { browser, state } = createRecoveryBrowser({
      read: (current) => Promise.resolve({
        ready: true,
        generating: false,
        latestUserText: current.submittedPrompt,
        latestAssistantText:
          current.reloads > 0
            ? `Reloaded result\n${completionMarker(current.submittedPrompt)}`
            : "finished marker not visible",
        latestAssistantTruncated: false,
        tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
      }),
    });
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "reload", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(state.submissions).toBe(1);
    expect(state.reloads).toBe(1);
    expect(state.activations).toEqual([]);
    expect(state.reads).toBeGreaterThan(1);
    expect(collected.state).toBe("COMPLETE");
  }, 15_000);

  it("does not mask worker identity mismatch as recovery exhaustion", async () => {
    const { browser, state } = createRecoveryBrowser({
      read: (current) => Promise.resolve({
        ready: true,
        generating: false,
        latestUserText: current.reads === 1 ? current.submittedPrompt : "different worker turn",
        latestAssistantText: "finished marker never observable",
        latestAssistantTruncated: false,
        tab: { tabId: 1, windowId: 10, active: false, discarded: false, status: "complete" },
      }),
    });
    const runtime = new AgentRuntime(browser);
    const spawned = await runtime.spawnAgents([{ agent_id: "identity", prompt: "answer once" }], 1);

    const collected = await runtime.collectAgents(spawned.run_id);

    expect(state.submissions).toBe(1);
    expect(state.reloads).toBe(0);
    expect(collected).toMatchObject({
      state: "FAILED",
      failed: [{
        agent_id: "identity",
        error: { code: "WORKER_IDENTITY_MISMATCH", retryable: false },
      }],
    });
  });
});
