import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defaultNativeHostDirectories,
  EXTENSION_ID,
  startChromeMcpStack,
} from "./chrome-mcp-stack.mjs";

export const LIVE_CODE_REVIEW_FAILURE = Object.freeze({
  AUTH: "auth",
  CHROME_PROFILE: "chrome-profile",
  CHROME: "chrome",
  EXTENSION: "extension",
  NATIVE_HOST: "native-host",
  TUNNEL_APP: "tunnel-app",
  ENDPOINT_COLLISION: "endpoint-collision",
  CANARY: "canary",
  WORKER: "worker",
  WORKFLOW: "workflow",
  ARTIFACTS: "artifacts",
});

const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const GENERATING_SELECTOR =
  'button[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label="Stop"]';
const CHATGPT_ORIGIN = "https://chatgpt.com";
const DEFAULT_CANARY = "komaksym/chrome-browser-mcp#34";
const DEFAULT_MCP_PORT = 2191;
const NORMAL_MCP_PORTS = new Set([2091, 2093, 2095]);
const RUNTIME_COMPLETION_MARKER_PATTERN = /<<<SUBAGENT_DONE:[A-Za-z0-9-]+>>>/g;
const TUNNEL_ENV_OVERRIDES = [
  "CONTROL_PLANE_TUNNEL_ID",
  "MCP_COMMAND",
  "MCP_SERVER_URL",
  "TUNNEL_CLIENT_CONFIG",
  "TUNNEL_CLIENT_PROFILE",
  "TUNNEL_CLIENT_PROFILE_DIR",
  "TUNNEL_CLIENT_PROFILE_FILE",
];

/** Classifies a setup or workflow failure without exposing a stack trace to the terminal. */
export class LiveCodeReviewSetupError extends Error {
  constructor(category, message, options) {
    super(message, options);
    this.name = "LiveCodeReviewSetupError";
    this.category = category;
  }
}

/** Returns whether a path is equal to or nested beneath another resolved path. */
function pathIsInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

/** Rejects repository and normal-profile locations for the persistent live test profile. */
export function assertDedicatedProfilePath({ profileDir, root, userHome = homedir() }) {
  const resolvedProfile = resolve(profileDir);
  if (pathIsInside(root, resolvedProfile)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CHROME_PROFILE,
      `Live code-review profile must live outside the repository: ${resolvedProfile}`,
    );
  }
  const personalRoots = [
    join(userHome, "Library/Application Support/Google/Chrome"),
    join(userHome, ".config/google-chrome"),
    join(userHome, ".config/chromium"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/User Data") : undefined,
  ].filter(Boolean);
  if (personalRoots.some((personalRoot) => pathIsInside(personalRoot, resolvedProfile))) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CHROME_PROFILE,
      `Refusing to use a normal Chrome profile tree for live code review: ${resolvedProfile}`,
    );
  }
  return resolvedProfile;
}

/** Parses one bounded loopback port and rejects the normal Chrome MCP endpoints. */
function parsePort(value, name, { allowZero = false, rejectNormal = false } = {}) {
  const minimum = allowZero ? 0 : 1024;
  if (!/^[0-9]+$/.test(value)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ENDPOINT_COLLISION,
      `${name} must be an integer between ${minimum} and 65535; got ${value}`,
    );
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ENDPOINT_COLLISION,
      `${name} must be an integer between ${minimum} and 65535; got ${value}`,
    );
  }
  if (rejectNormal && NORMAL_MCP_PORTS.has(port)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ENDPOINT_COLLISION,
      `${name} must not reuse a normal Chrome MCP port; choose a dedicated live endpoint`,
    );
  }
  return port;
}

/** Parses a bounded phase timeout without conflating milliseconds with a TCP port. */
function parseDuration(value, name) {
  if (!/^[0-9]+$/.test(value)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      `${name} must be a positive duration in milliseconds; got ${value}`,
    );
  }
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 3_600_000) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      `${name} must be between 1000 and 3600000 milliseconds; got ${value}`,
    );
  }
  return duration;
}

/** Parses the owner/repository/pull-request canary format used by the live run. */
export function parseCanary(value = DEFAULT_CANARY) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if (!match) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CANARY,
      `LIVE_CHATGPT_CANARY must look like owner/repo#123; got ${value}`,
    );
  }
  return { owner: match[1], repo: match[2], prNumber: Number.parseInt(match[3], 10) };
}

/** Loads live-run configuration while keeping profile, endpoint, and tunnel state isolated. */
export function loadLiveCodeReviewConfig({ env = process.env, root, userHome = homedir() }) {
  const profileDir = assertDedicatedProfilePath({
    profileDir: env.LIVE_CHATGPT_PROFILE_DIR ?? join(userHome, ".chrome-browser-mcp/live-smoke/chrome-profile"),
    root,
    userHome,
  });
  const tunnelProfile = env.LIVE_CHATGPT_TUNNEL_PROFILE ?? "chrome-browser-mcp-live-smoke";
  if (tunnelProfile === "chrome-browser-mcp" || tunnelProfile === "chrome-browser-mcp-2" || tunnelProfile === "chrome-browser-mcp-3") {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
      "LIVE_CHATGPT_TUNNEL_PROFILE must name a dedicated live-smoke tunnel profile",
    );
  }
  const artifactDir = resolve(env.LIVE_CHATGPT_ARTIFACT_DIR ?? join(tmpdir(), "chrome-browser-mcp-live-smoke"));
  if (pathIsInside(root, artifactDir)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ARTIFACTS,
      `Live diagnostics must be written outside the repository: ${artifactDir}`,
    );
  }
  return {
    artifactDir,
    canary: parseCanary(env.LIVE_CHATGPT_CANARY ?? DEFAULT_CANARY),
    chromeMcpAppLabel: env.LIVE_CHATGPT_CHROME_MCP_APP_LABEL ?? "chrome-mcp",
    chromePath: env.LIVE_CHATGPT_CHROME_PATH,
    debugPort: env.LIVE_CHATGPT_DEBUG_PORT
      ? parsePort(env.LIVE_CHATGPT_DEBUG_PORT, "LIVE_CHATGPT_DEBUG_PORT", { allowZero: true })
      : 0,
    mcpPort: parsePort(env.LIVE_CHATGPT_MCP_PORT ?? String(DEFAULT_MCP_PORT), "LIVE_CHATGPT_MCP_PORT", {
      rejectNormal: true,
    }),
    noSandbox: env.LIVE_CHATGPT_NO_SANDBOX === "1",
    profileDir,
    setupTimeoutMs: parseDuration(env.LIVE_CHATGPT_SETUP_TIMEOUT_MS ?? "120000", "LIVE_CHATGPT_SETUP_TIMEOUT_MS"),
    skillsMcpAppLabel: env.LIVE_CHATGPT_SKILLS_MCP_APP_LABEL ?? "skills-mcp",
    tunnelProfile,
    userHome,
    workflowTimeoutMs: parseDuration(
      env.LIVE_CHATGPT_WORKFLOW_TIMEOUT_MS ?? "600000",
      "LIVE_CHATGPT_WORKFLOW_TIMEOUT_MS",
    ),
  };
}

/** Creates the run identity and two test-owned worker-axis markers. */
export function createLiveRunIdentity(seed = `CBMCP-LIVE-${randomUUID()}`) {
  return {
    runId: seed,
    collectionMarker: `CBMCP_LIVE_COLLECTION_VERIFIED:${seed}`,
    axes: [
      {
        id: "architecture",
        marker: `CBMCP_LIVE_WORKER_DONE:${seed}:ARCHITECTURE`,
      },
      {
        id: "security",
        marker: `CBMCP_LIVE_WORKER_DONE:${seed}:SECURITY`,
      },
    ],
  };
}

/** Builds the exact parent request used to exercise the real skills and Chrome MCP path. */
export function buildStrictCodeReviewPrompt({ canary, identity }) {
  const repo = `${canary.repo}#${canary.prNumber}`;
  const changedFiles = canary.changedFiles ?? [];
  return [
    "@skills-mcp /code-review",
    "",
    "Run the strict two-worker code review through the configured chrome-mcp app.",
    `LIVE_SMOKE_RUN_ID: ${identity.runId}`,
    `CANARY_REPOSITORY: ${repo}`,
    `PINNED_BASE_REF: ${canary.baseRef}`,
    `PINNED_BASE_SHA: ${canary.baseSha}`,
    `PINNED_HEAD_REF: ${canary.headRef}`,
    `PINNED_HEAD_SHA: ${canary.headSha}`,
    `CANARY_CHANGED_FILES_JSON: ${JSON.stringify(changedFiles)}`,
    "",
    "Call the configured chrome-mcp tool `spawn_agents` exactly one time with exactly two tasks and `max_concurrency: 2`.",
    "The parent conversation must create two independent ChatGPT worker conversations; do not review in the parent, call a direct API, or fall back to sequential or same-context analysis.",
    `Task 1 is the architecture axis with agent_id live-architecture-${identity.runId} and must include this exact marker in its worker prompt and final response: ${identity.axes[0].marker}`,
    `Task 2 is the security axis with agent_id live-security-${identity.runId} and must include this exact marker in its worker prompt and final response: ${identity.axes[1].marker}`,
    "Pass the exact run identity, canary repository, and pinned base/head metadata to both workers.",
    `Each worker final response must include WORKER_REVIEW_COMPLETED: true, REVIEWED_CANARY: ${repo}, REVIEWED_BASE_REF: ${canary.baseRef}, REVIEWED_HEAD_REF: ${canary.headRef}, REVIEWED_BASE_SHA: ${canary.baseSha}, REVIEWED_HEAD_SHA: ${canary.headSha}, and REVIEW_FINDINGS: after actually reviewing the pinned change.`,
    "Each worker must also return one-line fields: AXIS_REVIEW: ARCHITECTURE or SECURITY, REVIEWED_FILES_JSON: as a JSON array of exact paths with at least one path from CANARY_CHANGED_FILES_JSON, FINDING_COUNT: as a non-negative integer, and FINDING_SEVERITIES: as comma-separated P0-P3 values or none, with concrete file/line/diff evidence or an explicit no-findings explanation; a completion acknowledgement alone is not valid.",
    "After both workers have accepted their prompts, call `collect_agents` through chrome-mcp until its public barrier reports `satisfied: true` and it contains exactly two verified results with no terminal failures.",
    `Do not report success until both independent results are collected. Your final assistant response must contain ${identity.collectionMarker}, BARRIER_SATISFIED: true, VERIFIED_RESULT_COUNT: 2, TERMINAL_FAILURE_COUNT: 0, the live run identity, the canary repository, and both worker markers.`,
  ].join("\n");
}

/** Defines the bounded review envelope required from each independent worker. */
function workerReviewRequirements({ canary, identity, axis }) {
  return {
    changedFiles: canary.changedFiles ?? [],
    markers: [
      axis.marker,
      `LIVE_SMOKE_RUN_ID: ${identity.runId}`,
      `REVIEWED_CANARY: ${canary.repo}#${canary.prNumber}`,
      `REVIEWED_BASE_REF: ${canary.baseRef}`,
      `REVIEWED_HEAD_REF: ${canary.headRef}`,
      `REVIEWED_BASE_SHA: ${canary.baseSha}`,
      `REVIEWED_HEAD_SHA: ${canary.headSha}`,
      "WORKER_REVIEW_COMPLETED: true",
      `AXIS_REVIEW: ${axis.id.toUpperCase()}`,
      "REVIEWED_FILES_JSON:",
      "FINDING_COUNT:",
      "FINDING_SEVERITIES:",
      "REVIEW_FINDINGS:",
    ],
  };
}

/** Returns whether a URL identifies a top-level real ChatGPT page. */
function isChatGptPageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === CHATGPT_ORIGIN && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}

/** Extracts a visible ChatGPT conversation ID when the application has committed one into the URL. */
export function extractConversationId(url) {
  try {
    const match = /^\/c\/([^/]+)$/.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Filters a CDP target inventory to only new top-level ChatGPT worker candidates. */
export function collectNewWorkerTargets(targetInfos, baselineTargetIds, parentTargetId) {
  return targetInfos.filter(
    (target) =>
      target.type === "page" &&
      isChatGptPageUrl(target.url) &&
      !baselineTargetIds.has(target.targetId) &&
      target.targetId !== parentTargetId,
  );
}

/** Requires exactly two distinct worker targets in the parent browser window. */
export function assertExactlyTwoWorkerTargets(targets, { parentWindowId }) {
  if (targets.length !== 2) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKER,
      `Expected exactly two new ChatGPT worker conversations, observed ${targets.length}`,
    );
  }
  const targetIds = new Set(targets.map((target) => target.targetId));
  if (targetIds.size !== 2 || targets.some((target) => target.type !== "page" || !isChatGptPageUrl(target.url))) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKER,
      "Worker target identities were not two distinct top-level ChatGPT pages",
    );
  }
  if (targets.some((target) => target.windowId !== parentWindowId)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKER,
      "A ChatGPT worker opened outside the parent's Chrome window",
    );
  }
  return targets;
}

/** Removes query strings and fragments from a URL before it reaches diagnostics. */
export function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1_000);
  } catch {
    return "<invalid-url>";
  }
}

/** Sanitizes CDP targets without copying titles, page text, or credentials into artifacts. */
export function sanitizeTargetInventory(targetInfos) {
  return targetInfos.map((target) => ({
    targetId: target.targetId,
    type: target.type,
    windowId: target.windowId,
    url: sanitizeUrl(target.url),
  }));
}

/** Resolves and records the canary PR's current base/head metadata before prompting ChatGPT. */
export async function fetchCanaryRef(canary, githubToken) {
  const url = `https://api.github.com/repos/${canary.owner}/${canary.repo}/pulls/${canary.prNumber}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "chrome-browser-mcp-live-code-review" };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CANARY,
      `Could not reach canary ${canary.owner}/${canary.repo}#${canary.prNumber}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CANARY,
      `Canary ${canary.owner}/${canary.repo}#${canary.prNumber} returned HTTP ${response.status}`,
    );
  }
  const pullRequest = await response.json();
  const changedFiles = [];
  const visitedFilePages = new Set();
  let filesUrl = `${url}/files?per_page=100`;
  while (filesUrl) {
    if (visitedFilePages.has(filesUrl)) {
      throw new LiveCodeReviewSetupError(
        LIVE_CODE_REVIEW_FAILURE.CANARY,
        `Changed-file metadata for canary ${canary.owner}/${canary.repo}#${canary.prNumber} repeated a page`,
      );
    }
    visitedFilePages.add(filesUrl);
    let filesResponse;
    try {
      filesResponse = await fetch(filesUrl, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new LiveCodeReviewSetupError(
        LIVE_CODE_REVIEW_FAILURE.CANARY,
        `Could not reach changed-file metadata for canary ${canary.owner}/${canary.repo}#${canary.prNumber}`,
        { cause: error },
      );
    }
    if (!filesResponse.ok) {
      throw new LiveCodeReviewSetupError(
        LIVE_CODE_REVIEW_FAILURE.CANARY,
        `Changed-file metadata for canary ${canary.owner}/${canary.repo}#${canary.prNumber} returned HTTP ${filesResponse.status}`,
      );
    }
    const files = await filesResponse.json();
    if (!Array.isArray(files)) {
      throw new LiveCodeReviewSetupError(
        LIVE_CODE_REVIEW_FAILURE.CANARY,
        `Changed-file metadata for canary ${canary.owner}/${canary.repo}#${canary.prNumber} was not a list`,
      );
    }
    changedFiles.push(...files.map((file) => file?.filename).filter((filename) => typeof filename === "string"));
    const nextLink = filesResponse.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!nextLink) {
      filesUrl = null;
      continue;
    }
    const nextUrl = new URL(nextLink, "https://api.github.com");
    if (nextUrl.origin !== "https://api.github.com") {
      throw new LiveCodeReviewSetupError(
        LIVE_CODE_REVIEW_FAILURE.CANARY,
        `Changed-file metadata for canary ${canary.owner}/${canary.repo}#${canary.prNumber} linked outside GitHub`,
      );
    }
    filesUrl = nextUrl.toString();
  }
  const uniqueChangedFiles = [...new Set(changedFiles)];
  const pinned = {
    repo: `${canary.owner}/${canary.repo}`,
    prNumber: canary.prNumber,
    state: pullRequest.state,
    draft: Boolean(pullRequest.draft),
    baseRef: pullRequest.base?.ref,
    baseSha: pullRequest.base?.sha,
    headRef: pullRequest.head?.ref,
    headSha: pullRequest.head?.sha,
    changedFiles: uniqueChangedFiles,
    changedFileCount: pullRequest.changed_files,
  };
  if (
    [pinned.baseRef, pinned.baseSha, pinned.headRef, pinned.headSha].some((value) => typeof value !== "string") ||
    !Number.isInteger(pinned.changedFileCount) ||
    pinned.changedFileCount <= 0 ||
    pinned.changedFileCount !== pinned.changedFiles.length
  ) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CANARY,
      `Canary ${pinned.repo}#${pinned.prNumber} did not expose complete pinned refs or changed-file metadata`,
    );
  }
  return pinned;
}

/** Builds a tunnel-client invocation that cannot inherit a personal tunnel selector or endpoint. */
export function tunnelClientInvocation({ command, profile, mcpUrl, env = process.env, explain = false }) {
  const childEnv = { ...env };
  for (const name of TUNNEL_ENV_OVERRIDES) delete childEnv[name];
  const args = [command, "--profile", profile, "--mcp.server-url", mcpUrl];
  if (explain) args.push("--explain");
  return { args, env: childEnv };
}

/** Summarizes only parent-phase MCP tool names recorded by the isolated proxy. */
export function summarizeParentMcpCalls(traffic, phase = "parent-workflow") {
  const calls = traffic.filter((entry) => entry.phase === phase && entry.method === "tools/call");
  const spawnIndex = calls.findIndex((entry) => entry.name === "spawn_agents");
  return {
    calls: calls.map((entry) => entry.name),
    cancelAgents: calls.filter((entry) => entry.name === "cancel_agents").length,
    collectAgents: calls.filter((entry) => entry.name === "collect_agents").length,
    collectAfterSpawnAgents:
      spawnIndex < 0 ? 0 : calls.filter((entry, index) => entry.name === "collect_agents" && index > spawnIndex).length,
    spawnAgents: calls.filter((entry) => entry.name === "spawn_agents").length,
    spawnShapes: calls
      .filter((entry) => entry.name === "spawn_agents")
      .map((entry) => ({
        axisPromptMarkerCount: entry.axisPromptMarkerCount ?? null,
        axisPromptMarkerTaskCounts: entry.axisPromptMarkerTaskCounts ?? null,
        axisPromptMarkerTaskIndexes: entry.axisPromptMarkerTaskIndexes ?? null,
        distinctAgentIdCount: entry.distinctAgentIdCount ?? null,
        maxConcurrency: entry.maxConcurrency ?? null,
        nonEmptyPromptCount: entry.nonEmptyPromptCount ?? null,
        promptCount: entry.promptCount ?? null,
        runIdPromptCount: entry.runIdPromptCount ?? null,
        taskCount: entry.taskCount ?? null,
      })),
  };
}

/** Requires one parent spawn, at least one post-spawn collection, and no test-side cancellation. */
export function assertParentMcpWorkflow(traffic, phase = "parent-workflow", correlation = {}) {
  const summary = summarizeParentMcpCalls(traffic, phase);
  if (summary.spawnAgents !== 1) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      `The parent invoked spawn_agents ${summary.spawnAgents} times; expected exactly once through the configured MCP path`,
    );
  }
  const [spawnShape] = summary.spawnShapes;
  if (
    spawnShape?.taskCount !== 2 ||
    spawnShape.distinctAgentIdCount !== 2 ||
    spawnShape.promptCount !== 2 ||
    spawnShape.nonEmptyPromptCount !== 2 ||
    spawnShape.maxConcurrency !== 2
  ) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent spawn_agents payload did not contain exactly two distinct non-empty tasks with max_concurrency: 2",
    );
  }
  if (
    typeof correlation.expectedRunId === "string" &&
    (spawnShape.runIdPromptCount !== spawnShape.taskCount ||
      spawnShape.runIdPromptCount !== spawnShape.promptCount)
  ) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent spawn_agents prompts were not correlated with this live run identity",
    );
  }
  if (
    Array.isArray(correlation.expectedAxisMarkers) &&
    correlation.expectedAxisMarkers.length > 0 &&
    (spawnShape.axisPromptMarkerCount !== correlation.expectedAxisMarkers.length ||
      !Array.isArray(spawnShape.axisPromptMarkerTaskCounts) ||
      !spawnShape.axisPromptMarkerTaskCounts.every((count) => count === 1) ||
      !Array.isArray(spawnShape.axisPromptMarkerTaskIndexes) ||
      new Set(spawnShape.axisPromptMarkerTaskIndexes).size !== correlation.expectedAxisMarkers.length)
  ) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent spawn_agents prompts were not correlated with both requested review axes",
    );
  }
  if (summary.collectAfterSpawnAgents < 1) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent did not invoke collect_agents after spawning workers through the configured MCP path",
    );
  }
  if (summary.cancelAgents !== 0) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent cancelled the strict review run instead of collecting its worker results",
    );
  }
  return summary;
}

/** Runs the dedicated tunnel profile's doctor command against this run's endpoint. */
function runTunnelDoctor({ profile, mcpUrl, root, env, timeoutMs }) {
  const invocation = tunnelClientInvocation({ command: "doctor", profile, mcpUrl, env, explain: true });
  const result = spawnSync("tunnel-client", invocation.args, {
    cwd: root,
    env: invocation.env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: timeoutMs,
  });
  if (result.error?.code === "ENOENT") {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
      "tunnel-client is not installed or is not on PATH",
    );
  }
  if (result.status !== 0) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
      `Dedicated tunnel profile ${profile} is not ready for the isolated endpoint`,
    );
  }
}

/** Starts one test-owned tunnel process after its dedicated profile passes doctor. */
function startTunnel({ profile, mcpUrl, root, env }) {
  const invocation = tunnelClientInvocation({ command: "run", profile, mcpUrl, env });
  const tunnel = spawn("tunnel-client", invocation.args, {
    cwd: root,
    env: invocation.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(tunnel), 500);
    tunnel.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new LiveCodeReviewSetupError(
          LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
          `Could not start tunnel-client for dedicated profile ${profile}`,
          { cause: error },
        ),
      );
    });
    tunnel.once("exit", () => {
      if (tunnel.exitCode !== null) {
        clearTimeout(timer);
        reject(
          new LiveCodeReviewSetupError(
            LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
            `tunnel-client exited before the live workflow started for profile ${profile}`,
          ),
        );
      }
    });
  });
}

/** Stops only the tunnel process created by this live run. */
async function stopTunnel(tunnel) {
  if (!tunnel || tunnel.exitCode !== null) return;
  tunnel.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => tunnel.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (tunnel.exitCode === null) tunnel.kill("SIGKILL");
}

/** Waits for a bounded asynchronous condition and labels the failing workflow phase. */
export async function waitForCondition(label, predicate, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
      if (error instanceof LiveCodeReviewSetupError) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new LiveCodeReviewSetupError(
    LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
    `${label} did not complete within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    { cause: lastError },
  );
}

/** Opens the real ChatGPT origin and requires an authenticated, usable composer. */
async function requireAuthenticatedChatGpt(page, timeoutMs) {
  try {
    await page.goto(`${CHATGPT_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.AUTH,
      "ChatGPT could not be opened in the dedicated live profile",
      { cause: error },
    );
  }
  if (/\/(?:auth|login|signup)(?:\/|$)/i.test(new URL(page.url()).pathname)) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.AUTH,
      "The dedicated live profile is not authenticated to ChatGPT; sign in manually and retry",
    );
  }
  const composer = page.locator("#prompt-textarea, textarea, [contenteditable='true']").first();
  try {
    await composer.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.AUTH,
      "ChatGPT did not expose an authenticated composer in the dedicated live profile",
      { cause: error },
    );
  }
}

/** Opens the visible ChatGPT tool/app picker using stable accessible button names. */
async function openAppPicker(page) {
  for (const pattern of [/tools/i, /apps/i, /add files/i, /attach/i, /more/i]) {
    const button = page.getByRole("button", { name: pattern }).first();
    if ((await button.count()) > 0 && (await button.isVisible())) {
      await button.click();
      return;
    }
  }
}

/** Returns text from the currently visible app-picker surface only. */
async function visiblePickerText(page) {
  const candidates = page.locator(
    '[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]',
  );
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) return candidate.innerText();
  }
  return "";
}

/** Checks app labels without treating arbitrary page content as configuration evidence. */
function appLabelsPresent(text, { skillsMcpAppLabel, chromeMcpAppLabel }) {
  const normalized = text.toLowerCase();
  const skillsLabels = [skillsMcpAppLabel, "skills mcp"].map((label) => label.toLowerCase());
  const chromeLabels = [chromeMcpAppLabel, "chrome browser", "chrome mcp"].map((label) => label.toLowerCase());
  return {
    skillsPresent: skillsLabels.some((label) => normalized.includes(label)),
    chromePresent: chromeLabels.some((label) => normalized.includes(label)),
  };
}

/** Requires both configured ChatGPT MCP apps to be visible before the parent prompt is submitted. */
async function requireChatGptApps(page, config) {
  await openAppPicker(page);
  let pickerText = await visiblePickerText(page);
  let apps = appLabelsPresent(pickerText, config);
  if ((!apps.skillsPresent || !apps.chromePresent) && /more/i.test(pickerText)) {
    const more = page.getByText(/^more$/i).last();
    if ((await more.count()) > 0 && (await more.isVisible())) {
      await more.click();
      pickerText = await visiblePickerText(page);
      apps = appLabelsPresent(pickerText, config);
    }
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  if (!apps.skillsPresent || !apps.chromePresent) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.TUNNEL_APP,
      `ChatGPT app preflight is incomplete: skills-mcp=${apps.skillsPresent}, chrome-mcp=${apps.chromePresent}. Enable both apps in the dedicated account and point chrome-mcp at tunnel profile ${config.tunnelProfile}`,
    );
  }
}

/** Returns bounded runtime and MCP metadata from the isolated bridge before the live prompt. */
async function readRuntimeMetadata(root, client) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "dist/extension/manifest.json"), "utf8"));
  const status = await client.callTool({ name: "browser_status", arguments: {} });
  if (status.isError || !status.structuredContent) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.NATIVE_HOST,
      "browser_status failed against the isolated Chrome MCP bridge",
    );
  }
  const runtime = status.structuredContent;
  if (runtime.extensionId !== EXTENSION_ID) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.EXTENSION,
      `Unexpected extension identity ${runtime.extensionId ?? "unknown"}; expected ${EXTENSION_ID}`,
    );
  }
  const versions = [packageJson.version, manifest.version, runtime.extensionVersion, runtime.mcpVersion];
  if (versions.some((version) => typeof version !== "string" || version.length === 0) || new Set(versions).size !== 1) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ARTIFACTS,
      `Runtime version metadata is not synchronized: ${JSON.stringify(versions)}`,
    );
  }
  return { version: packageJson.version, runtime };
}

/** Requires the parent-facing MCP surface to advertise the worker tools used by the strict request. */
async function requireExpectedTools(client) {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  const required = ["browser_status", "get_active_tab", "spawn_agents", "collect_agents", "cancel_agents"];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ARTIFACTS,
      `The isolated MCP bridge is missing expected tools: ${missing.join(", ")}`,
    );
  }
  return tools.tools.length;
}

/** Classifies generic stack errors at the setup boundary. */
function classifyStackFailure(error) {
  if (error instanceof LiveCodeReviewSetupError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|address already in use/i.test(message)) {
    return new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.ENDPOINT_COLLISION,
      "The dedicated live MCP endpoint is already in use; stop the other live run or choose another port",
      { cause: error },
    );
  }
  if (/user data directory.*in use|profile.*in use|SingletonLock/i.test(message)) {
    return new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.CHROME_PROFILE,
      "The dedicated live Chrome profile is already open; close that Chrome instance and retry",
      { cause: error },
    );
  }
  if (/native host|native messaging|Bridge did not become ready/i.test(message)) {
    return new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.NATIVE_HOST,
      "The native host did not establish the isolated bridge; inspect the isolated setup and retry",
      { cause: error },
    );
  }
  if (/extension|service worker/i.test(message)) {
    return new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.EXTENSION,
      "The built extension did not load with the expected identity; rebuild the committed extension and retry",
      { cause: error },
    );
  }
  return new LiveCodeReviewSetupError(
    LIVE_CODE_REVIEW_FAILURE.CHROME,
    "Google Chrome could not start for the live code-review run; inspect the isolated setup and retry",
    { cause: error },
  );
}

/** Starts the isolated browser, bridge, tunnel, and MCP preflight used by the live workflow. */
export async function startLiveCodeReviewEnvironment({ root, env = process.env } = {}) {
  const resolvedRoot = resolve(root ?? join(import.meta.dirname, "../../.."));
  const config = loadLiveCodeReviewConfig({ env, root: resolvedRoot });
  const identity = createLiveRunIdentity();
  const canary = await fetchCanaryRef(config.canary, env.GITHUB_TOKEN);
  const homeDir = await mkdtemp(join(tmpdir(), "chrome-browser-mcp-live-home-"));
  let stack;
  let client;
  let tunnel;
  let closed = false;
  let signalHandled = false;

  /** Closes this environment once, restores touched manifests, and removes its temporary home. */
  const close = async () => {
    if (closed) return;
    closed = true;
    await client?.close().catch(() => undefined);
    await stopTunnel(tunnel);
    await stack?.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  };

  /** Finishes run-owned cleanup before honoring an ordinary termination signal. */
  const handleSignal = (signal) => {
    if (signalHandled) return;
    signalHandled = true;
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };

  try {
    try {
      stack = await startChromeMcpStack({
        root: resolvedRoot,
        homeDir,
        profileDir: config.profileDir,
        chromePath: config.chromePath,
        mcpPort: config.mcpPort,
        debugPort: config.debugPort,
        nativeHostDirs: defaultNativeHostDirectories(config.userHome),
        noSandbox: config.noSandbox,
        onSignal: handleSignal,
        timeoutMs: config.setupTimeoutMs,
      });
    } catch (error) {
      throw classifyStackFailure(error);
    }

    client = new Client({ name: "chrome-live-code-review", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(stack.bridgeMcpUrl)));
    const toolCount = await requireExpectedTools(client);
    const { version, runtime } = await readRuntimeMetadata(resolvedRoot, client);
    runTunnelDoctor({
      profile: config.tunnelProfile,
      mcpUrl: stack.mcpUrl,
      root: resolvedRoot,
      env,
      timeoutMs: config.setupTimeoutMs,
    });
    tunnel = await startTunnel({ profile: config.tunnelProfile, mcpUrl: stack.mcpUrl, root: resolvedRoot, env });
    const cdp = await stack.browser.newBrowserCDPSession();
    const chromeVersion = await cdp.send("Browser.getVersion");
    return {
      browser: stack.browser,
      canary,
      client,
      config,
      context: stack.context,
      cdp,
      identity,
      mcpUrl: stack.mcpUrl,
      mcpTraffic: stack.mcpTraffic,
      setMcpTrafficPhase: stack.setMcpTrafficPhase,
      report: {
        endpoint: stack.mcpUrl,
        extensionId: runtime.extensionId,
        profileDir: config.profileDir,
        toolCount,
        tunnelProfile: config.tunnelProfile,
        versions: {
          chrome: chromeVersion.product,
          extension: runtime.extensionVersion,
          mcp: runtime.mcpVersion,
          package: version,
        },
        canary,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Waits for one fresh user turn to contain a test-owned identity marker. */
async function waitForUserMarker(page, marker, timeoutMs) {
  return waitForCondition(
    "parent prompt acceptance",
    async () => {
      const messages = await page.locator(USER_MESSAGE_SELECTOR).allInnerTexts();
      return messages.some((message) => message.includes(marker));
    },
    timeoutMs,
  );
}

/** Submits the strict request through visible ChatGPT UI controls and proves a fresh conversation turn. */
async function submitParentPrompt(page, prompt, identity, timeoutMs) {
  const existingUserMessages = await page.locator(USER_MESSAGE_SELECTOR).count();
  if (existingUserMessages !== 0) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The live parent conversation was not fresh before submission",
    );
  }
  const composer = page.locator("#prompt-textarea, textarea, [contenteditable='true']").first();
  await composer.fill(prompt);
  const sendCandidates = [
    page.locator('button[data-testid="send-button"]'),
    page.getByRole("button", { name: /send/i }),
  ];
  let sent = false;
  for (const candidate of sendCandidates) {
    if ((await candidate.count()) === 0 || !(await candidate.first().isVisible())) continue;
    await candidate.first().click();
    sent = true;
    break;
  }
  if (!sent) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.AUTH,
      "ChatGPT did not expose a visible send control for the fresh parent conversation",
    );
  }
  await waitForUserMarker(page, identity.runId, timeoutMs);
  const conversationId = await waitForCondition(
    "fresh parent conversation creation",
    async () => extractConversationId(page.url()),
    timeoutMs,
  );
  return { conversationId };
}

/** Returns whether a review field has a non-empty inline or following-line value. */
function hasNonEmptyReviewField(text, field) {
  const match = new RegExp(`${field}:([^\\r\\n]*)`, "i").exec(text);
  if (!match) return false;
  if (match[1].trim()) return true;
  const followingLine = text
    .slice(match.index + match[0].length)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return Boolean(followingLine && !/^[A-Z][A-Z0-9_]+:/.test(followingLine.trim()));
}

/** Returns a single-line machine-readable review field value when present. */
function reviewFieldValue(text, field) {
  const match = new RegExp(`${field}:([^\\r\\n]*)`, "i").exec(text);
  return match?.[1]?.trim() ?? "";
}

/** Parses the worker's one-line JSON list of reviewed changed files. */
function reviewedFilesValue(text) {
  const match = /REVIEWED_FILES_JSON:\s*(\[[^\r\n]*\])/i.exec(text);
  if (!match) return [];
  try {
    const files = JSON.parse(match[1]);
    return Array.isArray(files) ? files.filter((filename) => typeof filename === "string") : [];
  } catch {
    return [];
  }
}

/** Validates the count/severity summary emitted by one worker. */
function hasValidFindingSummary(text) {
  const countValue = reviewFieldValue(text, "FINDING_COUNT").toLowerCase();
  const severityValue = reviewFieldValue(text, "FINDING_SEVERITIES").toLowerCase();
  if (!/^\d+$/.test(countValue)) return false;
  const count = Number(countValue);
  if (!Number.isSafeInteger(count)) return false;
  if (count === 0) return severityValue === "none";
  const severities = severityValue.split(",").map((severity) => severity.trim());
  return severities.length === count && severities.every((severity) => /^p[0-3]$/.test(severity));
}

/** Reads identity, review-envelope, and generation evidence from one real worker page. */
async function workerPageEvidence(page, axis, requirements) {
  const users = await page.locator(USER_MESSAGE_SELECTOR).allInnerTexts();
  const assistants = await page.locator(ASSISTANT_MESSAGE_SELECTOR).allInnerTexts();
  const generating = (await page.locator(GENERATING_SELECTOR).count()) > 0;
  const assistantText = assistants.join("\n");
  const completionMarkers = [
    ...new Set(users.flatMap((message) => message.match(RUNTIME_COMPLETION_MARKER_PATTERN) ?? [])),
  ];
  const completionMarker = completionMarkers.length === 1 ? completionMarkers[0] : null;
  const reviewedFiles = reviewedFilesValue(assistantText);
  const reviewedChangedFile = requirements.changedFiles.some((filename) => reviewedFiles.includes(filename));
  return {
    assistantMarker: assistants.some((message) => message.includes(axis.marker)),
    assistantCompletionMarker: Boolean(completionMarker && assistantText.includes(completionMarker)),
    conversationId: extractConversationId(page.url()),
    reviewEnvelope: requirements.markers.every((marker) => assistantText.includes(marker)),
    reviewedChangedFile,
    generating,
    substantiveReview:
      assistantText.length >= 200 &&
      /\b(review|finding|issue|risk|recommendation)\b/i.test(assistantText) &&
      /\b(file|line|diff|hunk|patch)\b/i.test(assistantText) &&
      hasValidFindingSummary(assistantText) &&
      reviewedChangedFile &&
      ["REVIEWED_FILES_JSON", "FINDING_SEVERITIES", "REVIEW_FINDINGS"].every((field) =>
        hasNonEmptyReviewField(assistantText, field),
      ),
    userMarker: users.some((message) => message.includes(axis.marker)),
  };
}

/** Finds the two newly opened Playwright ChatGPT pages and matches each to one requested axis. */
async function waitForWorkerPages({ context, baselinePages, parentPage, axes, reviewRequirements, timeoutMs }) {
  return waitForCondition(
    "independent worker prompt acceptance",
    async () => {
      const pages = context
        .pages()
        .filter((page) => page !== parentPage && !baselinePages.has(page) && isChatGptPageUrl(page.url()));
      if (pages.length > axes.length) {
        throw new LiveCodeReviewSetupError(
          LIVE_CODE_REVIEW_FAILURE.WORKER,
          `More than two new ChatGPT worker pages appeared: ${pages.length}`,
        );
      }
      const matches = [];
      for (const axis of axes) {
        for (const page of pages) {
          const evidence = await workerPageEvidence(page, axis, reviewRequirements.get(axis.id));
          if (evidence.userMarker) {
            matches.push({ axis, evidence, page });
            break;
          }
        }
      }
      if (matches.length !== axes.length || new Set(matches.map((match) => match.page)).size !== axes.length) {
        return false;
      }
      return matches;
    },
    timeoutMs,
  );
}

/** Samples active-tab and visibility state without reading worker result bodies into diagnostics. */
async function sampleFocus({ client, cdp, parentPage, parentWindowId, workerMatches }) {
  const active = await client.callTool({ name: "get_active_tab", arguments: {} });
  if (active.isError || !active.structuredContent?.tab) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent ChatGPT tab was not the active public Chrome tab during worker execution",
    );
  }
  const parentVisibility = await parentPage.evaluate(() => document.visibilityState);
  if (parentVisibility !== "visible") {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The parent ChatGPT tab lost visibility while background workers were running",
    );
  }
  const workerVisibility = await Promise.all(
    workerMatches.map(async ({ page }) => page.evaluate(() => document.visibilityState)),
  );
  if (workerVisibility.some((visibility) => visibility !== "hidden")) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "A worker ChatGPT tab became visible instead of remaining in the background",
    );
  }
  const targets = (await cdp.send("Target.getTargets")).targetInfos;
  const parentTarget = targets.find((target) => target.type === "page" && sanitizeUrl(target.url) === sanitizeUrl(parentPage.url()));
  const activeTab = active.structuredContent.tab;
  if (activeTab.windowId !== parentWindowId || !isParentUrl(activeTab.url, parentPage.url())) {
    throw new LiveCodeReviewSetupError(
      LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
      "The active Chrome tab/window changed away from the live parent conversation",
    );
  }
  return {
    activeUrl: sanitizeUrl(activeTab.url),
    parentTargetId: parentTarget?.targetId ?? null,
    parentVisibility,
    parentWindowId,
    workerVisibility,
  };
}

/** Allows a root-to-conversation URL transition while requiring the same ChatGPT parent origin. */
function isParentUrl(activeUrl, parentUrl) {
  try {
    const active = new URL(activeUrl);
    const parent = new URL(parentUrl);
    if (active.origin !== parent.origin) return false;
    return active.pathname === parent.pathname || active.pathname === "/" || parent.pathname === "/";
  } catch {
    return false;
  }
}

/** Waits for both workers to finish independently before checking the parent collection marker. */
async function waitForWorkerCompletions({ matches, reviewRequirements, timeoutMs }) {
  return waitForCondition(
    "worker completion markers",
    async () => {
      const evidence = await Promise.all(
        matches.map(async (match) => ({
          ...match,
          evidence: await workerPageEvidence(match.page, match.axis, reviewRequirements.get(match.axis.id)),
        })),
      );
      if (
        evidence.some(
          ({ evidence: current }) =>
            current.generating ||
            !current.assistantMarker ||
            !current.assistantCompletionMarker ||
            !current.reviewEnvelope ||
            !current.substantiveReview,
        )
      ) return false;
      const conversationIds = evidence.map(({ evidence: current }) => current.conversationId).filter(Boolean);
      if (conversationIds.length !== 2 || new Set(conversationIds).size !== 2) {
        throw new LiveCodeReviewSetupError(
          LIVE_CODE_REVIEW_FAILURE.WORKER,
          "The two worker axes did not resolve to two distinct ChatGPT conversation identities",
        );
      }
      return evidence;
    },
    timeoutMs,
  );
}

/** Waits for the parent UI to show the explicit verified-collection marker and both axes. */
async function waitForParentCollection({ page, identity, canary, timeoutMs }) {
  return waitForCondition(
    "parent verified collection",
    async () => {
      const assistants = await page.locator(ASSISTANT_MESSAGE_SELECTOR).allInnerTexts();
      const response = assistants.findLast((message) => message.includes(identity.collectionMarker));
      if (!response) return false;
      if (
        !identity.axes.every((axis) => response.includes(axis.marker)) ||
        !response.includes(identity.runId) ||
        !response.includes("BARRIER_SATISFIED: true") ||
        !response.includes("VERIFIED_RESULT_COUNT: 2") ||
        !response.includes("TERMINAL_FAILURE_COUNT: 0") ||
        !response.includes(`CANARY_REPOSITORY: ${canary.repo}#${canary.prNumber}`) ||
        !response.includes(`PINNED_BASE_SHA: ${canary.baseSha}`) ||
        !response.includes(`PINNED_HEAD_SHA: ${canary.headSha}`)
      ) return false;
      if ((await page.locator(GENERATING_SELECTOR).count()) > 0) return false;
      return true;
    },
    timeoutMs,
  );
}

/** Closes only target IDs created during the current live run. */
async function closeOwnedTargets(cdp, targetIds) {
  for (const targetId of targetIds) {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** Replaces potentially sensitive diagnostic text with a short category/phase-safe message. */
function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, (url) => sanitizeUrl(url)).slice(0, 2_000);
}

/** Writes sanitized failure metadata, screenshots, and a Playwright trace outside the repository. */
async function writeFailureDiagnostics({
  artifactDir,
  canary,
  cdp,
  context,
  error,
  focusSamples,
  identity,
  mcpTraffic,
  parentPage,
  phase,
  traceStarted,
  workerMatches,
}) {
  const directory = join(artifactDir, identity.runId.replace(/[^A-Za-z0-9_.-]/g, "_"));
  await mkdir(directory, { recursive: true });
  const targetInfos = cdp ? (await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }))).targetInfos : [];
  await writeFile(
    join(directory, "diagnostics.json"),
    `${JSON.stringify(
      {
        canary,
        error: sanitizeErrorMessage(error),
        focusSamples,
        mcpCalls: summarizeParentMcpCalls(mcpTraffic ?? []),
        phase,
        runId: identity.runId,
        targets: sanitizeTargetInventory(targetInfos),
        workerAxes: workerMatches?.map(({ axis, evidence }) => ({
          axis: axis.id,
          assistantCompletionMarker: Boolean(evidence?.assistantCompletionMarker),
          conversationId: evidence?.conversationId ?? null,
          assistantMarker: Boolean(evidence?.assistantMarker),
          reviewEnvelope: Boolean(evidence?.reviewEnvelope),
          reviewedChangedFile: Boolean(evidence?.reviewedChangedFile),
          substantiveReview: Boolean(evidence?.substantiveReview),
          userMarker: Boolean(evidence?.userMarker),
        })) ?? [],
      },
      null,
      2,
    )}\n`,
  );
  if (parentPage && !parentPage.isClosed()) {
    await parentPage.screenshot({ path: join(directory, "parent.png"), fullPage: false }).catch(() => undefined);
  }
  for (const [index, match] of (workerMatches ?? []).entries()) {
    if (!match.page.isClosed()) {
      await match.page.screenshot({ path: join(directory, `worker-${index + 1}.png`), fullPage: false }).catch(() => undefined);
    }
  }
  if (traceStarted) {
    await context.tracing.stop({ path: join(directory, "trace.zip") }).catch(() => undefined);
  }
  return directory;
}

/** Runs the parent-driven strict two-worker flow and returns only bounded proof metadata. */
export async function runLiveCodeReview({ root, env = process.env } = {}) {
  const environment = await startLiveCodeReviewEnvironment({ root, env });
  const {
    canary,
    cdp,
    client,
    config,
    context,
    identity,
    mcpTraffic,
    setMcpTrafficPhase,
  } = environment;
  const baselinePages = new Set(context.pages());
  let parentPage;
  let parentTargetId;
  let parentWindowId;
  let traceStarted = false;
  let traceStopped = false;
  let workerMatches;
  let workerTargets = [];
  const ownedTargetIds = new Set();
  const focusSamples = [];
  let phase = "parent-setup";

  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    traceStarted = true;
    const targetIdsBeforeParent = new Set(
      (await cdp.send("Target.getTargets")).targetInfos.map((target) => target.targetId),
    );
    parentPage = await context.newPage();
    await parentPage.bringToFront();
    await requireAuthenticatedChatGpt(parentPage, config.setupTimeoutMs);
    await requireChatGptApps(parentPage, config);
    const targetBeforePrompt = (await cdp.send("Target.getTargets")).targetInfos;
    const parentTargetCandidates = targetBeforePrompt.filter(
      (target) =>
        target.type === "page" &&
        !targetIdsBeforeParent.has(target.targetId) &&
        isChatGptPageUrl(target.url),
    );
    const parentTarget = parentTargetCandidates.find(
      (target) => sanitizeUrl(target.url) === sanitizeUrl(parentPage.url()),
    ) ?? (parentTargetCandidates.length === 1 ? parentTargetCandidates[0] : undefined);
    if (!parentTarget) {
      throw new LiveCodeReviewSetupError(LIVE_CODE_REVIEW_FAILURE.WORKFLOW, "Could not identify the fresh parent ChatGPT target");
    }
    parentTargetId = parentTarget.targetId;
    parentWindowId = (await cdp.send("Browser.getWindowForTarget", { targetId: parentTargetId })).windowId;
    ownedTargetIds.add(parentTargetId);

    phase = "parent-submit";
    const prompt = buildStrictCodeReviewPrompt({ canary, identity });
    const reviewRequirements = new Map(
      identity.axes.map((axis) => [axis.id, workerReviewRequirements({ canary, identity, axis })]),
    );
    setMcpTrafficPhase("parent-workflow", {
      expectedAxisMarkers: identity.axes.map((axis) => axis.marker),
      expectedRunId: identity.runId,
    });
    const parentConversation = await submitParentPrompt(parentPage, prompt, identity, config.workflowTimeoutMs);
    focusSamples.push(await sampleFocus({ client, cdp, parentPage, parentWindowId, workerMatches: [] }));

    phase = "worker-create";
    const baselineTargetIds = new Set(targetBeforePrompt.map((target) => target.targetId));
    const workerTargetInventory = await waitForCondition(
      "exactly two worker target creation",
      async () => {
        const targetInfos = (await cdp.send("Target.getTargets")).targetInfos;
        const candidates = collectNewWorkerTargets(targetInfos, baselineTargetIds, parentTargetId);
        if (candidates.length > 2) {
          throw new LiveCodeReviewSetupError(
            LIVE_CODE_REVIEW_FAILURE.WORKER,
            `More than two new ChatGPT worker targets appeared: ${candidates.length}`,
          );
        }
        return candidates.length === 2 ? candidates : false;
      },
      config.workflowTimeoutMs,
    );
    const workerTargetsWithWindows = await Promise.all(
      workerTargetInventory.map(async (target) => ({
        ...target,
        windowId: (await cdp.send("Browser.getWindowForTarget", { targetId: target.targetId })).windowId,
      })),
    );
    workerTargets = assertExactlyTwoWorkerTargets(workerTargetsWithWindows, { parentWindowId });
    workerTargets.forEach((target) => ownedTargetIds.add(target.targetId));

    phase = "worker-prompts";
    workerMatches = await waitForWorkerPages({
      context,
      baselinePages,
      parentPage,
      axes: identity.axes,
      reviewRequirements,
      timeoutMs: config.workflowTimeoutMs,
    });
    focusSamples.push(await sampleFocus({ client, cdp, parentPage, parentWindowId, workerMatches }));

    phase = "worker-collection";
    workerMatches = await waitForWorkerCompletions({
      matches: workerMatches,
      reviewRequirements,
      timeoutMs: config.workflowTimeoutMs,
    });
    focusSamples.push(await sampleFocus({ client, cdp, parentPage, parentWindowId, workerMatches }));

    const mcpWorkflow = await waitForCondition(
      "parent chrome-mcp worker workflow",
      async () => {
        const summary = summarizeParentMcpCalls(mcpTraffic);
        if (summary.spawnAgents > 1 || summary.cancelAgents > 0) {
          throw new LiveCodeReviewSetupError(
            LIVE_CODE_REVIEW_FAILURE.WORKFLOW,
            "The parent did not follow the single-spawn, collect-only strict worker workflow",
          );
        }
        return summary.spawnAgents === 1 && summary.collectAfterSpawnAgents > 0 ? summary : false;
      },
      config.workflowTimeoutMs,
    );
    assertParentMcpWorkflow(mcpTraffic, "parent-workflow", {
      expectedAxisMarkers: identity.axes.map((axis) => axis.marker),
      expectedRunId: identity.runId,
    });

    phase = "parent-collection";
    await waitForParentCollection({
      page: parentPage,
      identity,
      canary,
      timeoutMs: config.workflowTimeoutMs,
    });
    if (traceStarted && !traceStopped) {
      await context.tracing.stop();
      traceStopped = true;
    }
    return {
      ...environment.report,
      parentConversationId: parentConversation.conversationId,
      runId: identity.runId,
      workerConversationIds: workerMatches.map(({ evidence }) => evidence.conversationId),
      workerTargetCount: workerTargets.length,
      mcpWorkflow,
      focusSamples,
    };
  } catch (error) {
    const classified = error instanceof LiveCodeReviewSetupError ? error : new LiveCodeReviewSetupError(LIVE_CODE_REVIEW_FAILURE.WORKFLOW, sanitizeErrorMessage(error), { cause: error });
    if (traceStarted && !traceStopped) {
      await writeFailureDiagnostics({
        artifactDir: config.artifactDir,
        canary,
        cdp,
        context,
        error: classified,
        focusSamples,
        identity,
        mcpTraffic,
        parentPage,
        phase,
        traceStarted,
        workerMatches,
      });
      traceStopped = true;
    }
    throw classified;
  } finally {
    await closeOwnedTargets(cdp, ownedTargetIds);
    if (traceStarted && !traceStopped) {
      await context.tracing.stop().catch(() => undefined);
      traceStopped = true;
    }
    await environment.close();
  }
}
