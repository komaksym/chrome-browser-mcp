import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isExpectedMcpPath, recordMcpTraffic } from "../e2e/support/chrome-mcp-stack.mjs";
import {
  LIVE_CODE_REVIEW_FAILURE,
  LiveCodeReviewSetupError,
  assertExactlyTwoWorkerTargets,
  assertParentMcpWorkflow,
  buildStrictCodeReviewPrompt,
  collectNewWorkerTargets,
  createLiveRunIdentity,
  loadLiveCodeReviewConfig,
  sanitizeUrl,
  summarizeParentMcpCalls,
  tunnelClientInvocation,
} from "../e2e/support/live-chatgpt-code-review.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("live ChatGPT code-review workflow", () => {
  it("builds a strict parent request with pinned canary metadata and two unique axes", () => {
    const identity = createLiveRunIdentity("fixed-run");
    const canary = {
      repo: "komaksym/chrome-browser-mcp",
      prNumber: 34,
      baseRef: "main",
      baseSha: "base-sha",
      changedFiles: ["src/live.ts", "tests/live.test.ts"],
      headRef: "fix/canary",
      headSha: "head-sha",
    };

    const prompt = buildStrictCodeReviewPrompt({ canary, identity });

    expect(prompt).toContain("@skills-mcp /code-review");
    expect(prompt).toContain("komaksym/chrome-browser-mcp#34");
    expect(prompt).toContain("PINNED_BASE_SHA: base-sha");
    expect(prompt).toContain("PINNED_HEAD_SHA: head-sha");
    expect(prompt).toContain('CANARY_CHANGED_FILES_JSON: ["src/live.ts","tests/live.test.ts"]');
    expect(prompt).toContain("LIVE_SMOKE_RUN_ID: fixed-run");
    expect(prompt).toContain(identity.axes[0].marker);
    expect(prompt).toContain(identity.axes[1].marker);
    expect(prompt).toContain("AXIS_REVIEW: ARCHITECTURE or SECURITY");
    expect(prompt).toContain("REVIEWED_FILES_JSON:");
    expect(prompt).toContain("FINDING_COUNT:");
    expect(prompt).toContain("FINDING_SEVERITIES:");
    expect(prompt).toContain("BARRIER_SATISFIED: true");
    expect(prompt).toContain("VERIFIED_RESULT_COUNT: 2");
    expect(prompt).toContain("TERMINAL_FAILURE_COUNT: 0");
    expect(prompt).toMatch(/spawn_agents.*exactly one/i);
    expect(prompt).toMatch(/max_concurrency.*2/i);
    expect(identity.axes[0].marker).not.toBe(identity.axes[1].marker);
  });

  it("keeps live configuration outside personal/repository state and normal endpoints", () => {
    const config = loadLiveCodeReviewConfig({
      root: repoRoot,
      userHome: "/Users/tester",
      env: {},
    });

    expect(config.profileDir).toBe("/Users/tester/.chrome-browser-mcp/live-smoke/chrome-profile");
    expect(config.mcpPort).toBe(2191);
    expect(config.tunnelProfile).toBe("chrome-browser-mcp-live-smoke");
    expect(config.workflowTimeoutMs).toBe(600_000);

    expect(() =>
      loadLiveCodeReviewConfig({
        root: repoRoot,
        userHome: "/Users/tester",
        env: { LIVE_CHATGPT_PROFILE_DIR: resolve(repoRoot, ".live-profile") },
      }),
    ).toThrowError(LiveCodeReviewSetupError);
    expect(() =>
      loadLiveCodeReviewConfig({
        root: repoRoot,
        userHome: "/Users/tester",
        env: { LIVE_CHATGPT_MCP_PORT: "2091" },
      }),
    ).toThrowError(LiveCodeReviewSetupError);
    expect(() =>
      loadLiveCodeReviewConfig({
        root: repoRoot,
        userHome: "/Users/tester",
        env: { LIVE_CHATGPT_TUNNEL_PROFILE: "chrome-browser-mcp" },
      }),
    ).toThrowError(LiveCodeReviewSetupError);
  });

  it("correlates only new ChatGPT page targets with the current run", () => {
    const targets = collectNewWorkerTargets(
      [
        { targetId: "old", type: "page", url: "https://chatgpt.com/", windowId: 7 },
        { targetId: "parent", type: "page", url: "https://chatgpt.com/c/parent", windowId: 7 },
        { targetId: "worker-1", type: "page", url: "https://chatgpt.com/", windowId: 7 },
        { targetId: "worker-2", type: "page", url: "https://chatgpt.com/", windowId: 7 },
        { targetId: "iframe", type: "iframe", url: "https://chatgpt.com/", windowId: 7 },
      ],
      new Set(["old", "parent"]),
    );

    expect(targets.map((target) => target.targetId)).toEqual(["worker-1", "worker-2"]);
  });

  it("requires exactly two distinct workers in the parent's window", () => {
    const workers = [
      { targetId: "worker-1", type: "page", url: "https://chatgpt.com/", windowId: 7 },
      { targetId: "worker-2", type: "page", url: "https://chatgpt.com/", windowId: 7 },
    ];

    expect(assertExactlyTwoWorkerTargets(workers, { parentWindowId: 7 })).toEqual(workers);
    expect(() => assertExactlyTwoWorkerTargets(workers.slice(0, 1), { parentWindowId: 7 })).toThrow(
      LIVE_CODE_REVIEW_FAILURE.WORKER,
    );
    expect(() =>
      assertExactlyTwoWorkerTargets(
        [...workers, { targetId: "worker-3", type: "page", url: "https://chatgpt.com/", windowId: 7 }],
        { parentWindowId: 7 },
      ),
    ).toThrow(LIVE_CODE_REVIEW_FAILURE.WORKER);
    expect(() => assertExactlyTwoWorkerTargets(workers, { parentWindowId: 8 })).toThrow(
      LIVE_CODE_REVIEW_FAILURE.WORKER,
    );
  });

  it("sanitizes URLs before writing live diagnostics", () => {
    expect(sanitizeUrl("https://chatgpt.com/c/abc?token=private#fragment")).toBe("https://chatgpt.com/c/abc");
    expect(sanitizeUrl("not a URL")).toBe("<invalid-url>");
  });

  it("gates the proxy to a unique run-scoped MCP path", () => {
    expect(isExpectedMcpPath("/mcp/live/run-123?session=ignored", "/mcp/live/run-123")).toBe(true);
    expect(isExpectedMcpPath("/mcp", "/mcp/live/run-123")).toBe(false);
    expect(isExpectedMcpPath("not a URL", "/mcp/live/run-123")).toBe(false);
  });

  it("forces tunnel-client to use only the dedicated run endpoint", () => {
    const invocation = tunnelClientInvocation({
      command: "run",
      profile: "chrome-browser-mcp-live-smoke",
      mcpUrl: "http://127.0.0.1:2191/mcp",
      env: {
        CONTROL_PLANE_TUNNEL_ID: "personal-tunnel",
        MCP_SERVER_URL: "http://127.0.0.1:2091/mcp",
        SAFE_VALUE: "retained",
      },
    });

    expect(invocation.args).toEqual([
      "run",
      "--profile",
      "chrome-browser-mcp-live-smoke",
      "--mcp.server-url",
      "http://127.0.0.1:2191/mcp",
    ]);
    expect(invocation.env).toMatchObject({ SAFE_VALUE: "retained" });
    expect(invocation.env).not.toHaveProperty("CONTROL_PLANE_TUNNEL_ID");
    expect(invocation.env).not.toHaveProperty("MCP_SERVER_URL");
  });

  it("records and requires the parent's spawn-then-collect MCP sequence without storing arguments", () => {
    const traffic = [];
    recordMcpTraffic({
      phase: "parent-workflow",
      expectedAxisMarkers: ["architecture-marker", "security-marker"],
      expectedRunId: "live-run",
      requestBody: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "spawn_agents",
          arguments: {
            max_concurrency: 2,
            tasks: [
              { agent_id: "architecture", prompt: "live-run architecture-marker private review text" },
              { agent_id: "security", prompt: "live-run security-marker private review text" },
            ],
          },
        },
      }),
      traffic,
    });
    recordMcpTraffic({
      phase: "parent-workflow",
      requestBody: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "collect_agents", arguments: { run_id: "private-run" } },
      }),
      traffic,
    });

    expect(summarizeParentMcpCalls(traffic)).toMatchObject({
      calls: ["spawn_agents", "collect_agents"],
      collectAfterSpawnAgents: 1,
      spawnAgents: 1,
      spawnShapes: [
        {
          axisPromptMarkerCount: 2,
          axisPromptMarkerTaskCounts: [1, 1],
          axisPromptMarkerTaskIndexes: [0, 1],
          distinctAgentIdCount: 2,
          maxConcurrency: 2,
          nonEmptyPromptCount: 2,
          promptCount: 2,
          runIdPromptCount: 2,
          taskCount: 2,
        },
      ],
    });
    expect(
      assertParentMcpWorkflow(traffic, "parent-workflow", {
        expectedAxisMarkers: ["architecture-marker", "security-marker"],
        expectedRunId: "live-run",
      }),
    ).toMatchObject({ spawnAgents: 1, collectAgents: 1 });
    expect(() =>
      assertParentMcpWorkflow(
        traffic.map((entry) =>
          entry.name === "spawn_agents" ? { ...entry, runIdPromptCount: 0 } : entry,
        ),
        "parent-workflow",
        {
          expectedAxisMarkers: ["architecture-marker", "security-marker"],
          expectedRunId: "live-run",
        },
      ),
    ).toThrow(/correlated with this live run identity/);
    expect(() =>
      assertParentMcpWorkflow(
        traffic.map((entry) =>
          entry.name === "spawn_agents" ? { ...entry, axisPromptMarkerTaskIndexes: [0, 0] } : entry,
        ),
        "parent-workflow",
        {
          expectedAxisMarkers: ["architecture-marker", "security-marker"],
          expectedRunId: "live-run",
        },
      ),
    ).toThrow(/both requested review axes/);
    expect(JSON.stringify(traffic)).not.toContain("private review text");
    expect(() =>
      assertParentMcpWorkflow([
        ...traffic,
        { method: "tools/call", name: "spawn_agents", phase: "parent-workflow", timestamp: 2 },
      ]),
    ).toThrow(/spawn_agents/);
  });

  it("keeps the live acceptance path free of fake ChatGPT and direct worker calls", () => {
    const source = [
      "tests/e2e/live-chatgpt-code-review.e2e.mjs",
      "tests/e2e/support/live-chatgpt-code-review.mjs",
      "tests/e2e/support/chrome-mcp-stack.mjs",
    ]
      .map((path) => readFileSync(resolve(repoRoot, path), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/route\.(fulfill|continue)|page\.route/);
    expect(source).not.toMatch(/callTool\(\s*\{\s*name:\s*["'](?:spawn_agents|collect_agents)["']/);
  });
});
