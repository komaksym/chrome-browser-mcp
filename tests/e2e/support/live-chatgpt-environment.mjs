import { spawn, spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXTENSION_ID, startChromeMcpStack } from "./chrome-mcp-stack.mjs";

export const LIVE_SMOKE_FAILURE = Object.freeze({
  AUTH: "auth",
  CHROME_PROFILE: "chrome-profile",
  CHROME: "chrome",
  EXTENSION: "extension",
  NATIVE_HOST: "native-host",
  TUNNEL_APP: "tunnel-app",
  ENDPOINT_COLLISION: "endpoint-collision",
  STALE_BUILD_ARTIFACTS: "stale-build-artifacts",
  CANARY: "canary",
});

export class LiveSmokeSetupError extends Error {
  constructor(category, message, options) {
    super(message, options);
    this.name = "LiveSmokeSetupError";
    this.category = category;
  }
}

function pathIsInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertDedicatedProfilePath({ profileDir, root, userHome = homedir() }) {
  const resolvedProfile = resolve(profileDir);
  if (pathIsInside(root, resolvedProfile)) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CHROME_PROFILE,
      `Live smoke profile must live outside the repository: ${resolvedProfile}`,
    );
  }

  const personalRoots = [
    join(userHome, "Library/Application Support/Google/Chrome"),
    join(userHome, ".config/google-chrome"),
    join(userHome, ".config/chromium"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/User Data") : undefined,
  ].filter(Boolean);
  if (personalRoots.some((personalRoot) => pathIsInside(personalRoot, resolvedProfile))) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CHROME_PROFILE,
      `Refusing to use a normal Chrome profile tree for live smoke: ${resolvedProfile}`,
    );
  }
  return resolvedProfile;
}

function parsePort(value) {
  if (!/^[0-9]+$/.test(value)) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.ENDPOINT_COLLISION,
      `LIVE_CHATGPT_MCP_PORT must be an integer between 1024 and 65535; got ${value}`,
    );
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.ENDPOINT_COLLISION,
      `LIVE_CHATGPT_MCP_PORT must be an integer between 1024 and 65535; got ${value}`,
    );
  }
  if (port === 2091) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.ENDPOINT_COLLISION,
      "LIVE_CHATGPT_MCP_PORT must not reuse the normal Chrome MCP port 2091; choose a dedicated live-smoke port.",
    );
  }
  return port;
}

export function parseCanary(value = "komaksym/chrome-browser-mcp#34") {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if (!match) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CANARY,
      `LIVE_CHATGPT_CANARY must look like owner/repo#123; got ${value}`,
    );
  }
  return { owner: match[1], repo: match[2], prNumber: Number.parseInt(match[3], 10) };
}

export function loadLiveSmokeConfig({ env = process.env, root, userHome = homedir() }) {
  const profileDir = assertDedicatedProfilePath({
    profileDir: env.LIVE_CHATGPT_PROFILE_DIR ?? join(userHome, ".chrome-browser-mcp/live-smoke/chrome-profile"),
    root,
    userHome,
  });
  const tunnelProfile = env.LIVE_CHATGPT_TUNNEL_PROFILE ?? "chrome-browser-mcp-live-smoke";
  if (tunnelProfile === "chrome-browser-mcp") {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.TUNNEL_APP,
      "LIVE_CHATGPT_TUNNEL_PROFILE must not reuse the normal chrome-browser-mcp tunnel profile.",
    );
  }
  return {
    canary: parseCanary(env.LIVE_CHATGPT_CANARY),
    chromePath: env.LIVE_CHATGPT_CHROME_PATH,
    chromeMcpAppLabel: env.LIVE_CHATGPT_CHROME_MCP_APP_LABEL ?? "chrome-mcp",
    mcpPort: parsePort(env.LIVE_CHATGPT_MCP_PORT ?? "2191"),
    profileDir,
    skillsMcpAppLabel: env.LIVE_CHATGPT_SKILLS_MCP_APP_LABEL ?? "skills-mcp",
    tunnelProfile,
    userHome,
  };
}

function shortProcessOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-3_000);
}

function verifyCommittedRuntimeArtifacts(root) {
  const result = spawnSync("npm", ["run", "artifacts:check"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.STALE_BUILD_ARTIFACTS,
      `Committed runtime artifacts are stale. Run npm run build and commit dist/. ${shortProcessOutput(result)}`,
    );
  }
}

export function assertRuntimeVersions({ packageVersion, manifestVersion, extensionId, extensionVersion, mcpVersion }) {
  if (extensionId !== EXTENSION_ID) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.EXTENSION,
      `Unexpected extension identity ${extensionId ?? "unknown"}; expected ${EXTENSION_ID}`,
    );
  }
  const versions = { package: packageVersion, manifest: manifestVersion, extension: extensionVersion, mcp: mcpVersion };
  if (Object.values(versions).some((version) => typeof version !== "string" || version.length === 0)) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.STALE_BUILD_ARTIFACTS,
      `Could not verify all runtime versions: ${JSON.stringify(versions)}`,
    );
  }
  if (new Set(Object.values(versions)).size !== 1) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.STALE_BUILD_ARTIFACTS,
      `Runtime version mismatch: ${JSON.stringify(versions)}`,
    );
  }
  return packageVersion;
}

async function fetchCanaryRef(canary, githubToken) {
  const url = `https://api.github.com/repos/${canary.owner}/${canary.repo}/pulls/${canary.prNumber}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "chrome-browser-mcp-live-smoke" };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CANARY,
      `Could not reach canary ${canary.owner}/${canary.repo}#${canary.prNumber}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CANARY,
      `Canary ${canary.owner}/${canary.repo}#${canary.prNumber} returned HTTP ${response.status}`,
    );
  }
  const pullRequest = await response.json();
  return {
    repo: `${canary.owner}/${canary.repo}`,
    prNumber: canary.prNumber,
    state: pullRequest.state,
    draft: Boolean(pullRequest.draft),
    baseRef: pullRequest.base?.ref,
    baseSha: pullRequest.base?.sha,
    headRef: pullRequest.head?.ref,
    headSha: pullRequest.head?.sha,
  };
}

const TUNNEL_ENV_OVERRIDES = [
  "CONTROL_PLANE_TUNNEL_ID",
  "MCP_COMMAND",
  "MCP_SERVER_URL",
  "TUNNEL_CLIENT_CONFIG",
  "TUNNEL_CLIENT_PROFILE",
  "TUNNEL_CLIENT_PROFILE_DIR",
  "TUNNEL_CLIENT_PROFILE_FILE",
];

export function tunnelClientInvocation({ command, profile, mcpUrl, env = process.env, explain = false }) {
  const childEnv = { ...env };
  for (const name of TUNNEL_ENV_OVERRIDES) delete childEnv[name];
  const args = [command, "--profile", profile, "--mcp.server-url", mcpUrl];
  if (explain) args.push("--explain");
  return { args, env: childEnv };
}

function runTunnelDoctor(profile, mcpUrl, root) {
  const invocation = tunnelClientInvocation({ command: "doctor", profile, mcpUrl, explain: true });
  const result = spawnSync("tunnel-client", invocation.args, {
    cwd: root,
    env: invocation.env,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error?.code === "ENOENT") {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.TUNNEL_APP,
      "tunnel-client is not installed or is not on PATH",
    );
  }
  if (result.status !== 0) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.TUNNEL_APP,
      `Tunnel profile ${profile} is not ready for the isolated bridge. Reconfigure it for the live-smoke endpoint and rerun tunnel-client doctor.`,
    );
  }
}

async function startTunnel(profile, mcpUrl, root) {
  const invocation = tunnelClientInvocation({ command: "run", profile, mcpUrl });
  const tunnel = spawn("tunnel-client", invocation.args, {
    cwd: root,
    env: invocation.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  if (tunnel.exitCode !== null) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.TUNNEL_APP,
      `tunnel-client exited immediately for profile ${profile}`,
    );
  }
  return tunnel;
}

async function stopTunnel(tunnel) {
  if (!tunnel || tunnel.exitCode !== null) return;
  tunnel.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => tunnel.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (tunnel.exitCode === null) tunnel.kill("SIGKILL");
}

function classifyStackFailure(error) {
  if (error instanceof LiveSmokeSetupError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|address already in use/i.test(message)) {
    return new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.ENDPOINT_COLLISION,
      "The isolated Chrome MCP endpoint is already in use. Stop the other live-smoke run or choose another LIVE_CHATGPT_MCP_PORT.",
      { cause: error },
    );
  }
  if (/user data directory.*in use|profile.*in use|SingletonLock/i.test(message)) {
    return new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.CHROME_PROFILE,
      "The dedicated live-smoke Chrome profile is already open. Close that dedicated Chrome instance and retry.",
      { cause: error },
    );
  }
  if (/extension|service worker/i.test(message) && !/native host/i.test(message)) {
    return new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.EXTENSION,
      `The built Chrome extension did not load/connect with the expected identity. ${message}`,
      { cause: error },
    );
  }
  if (/native host|native messaging|Bridge did not become ready/i.test(message)) {
    return new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.NATIVE_HOST,
      `The native host did not establish the isolated bridge. ${message}`,
      { cause: error },
    );
  }
  return new LiveSmokeSetupError(
    LIVE_SMOKE_FAILURE.CHROME,
    `Google Chrome could not start for live smoke. ${message}`,
    { cause: error },
  );
}

export function appLabelsPresent(text, { skillsMcpAppLabel, chromeMcpAppLabel }) {
  const normalized = text.toLowerCase();
  const skillsLabels = [skillsMcpAppLabel, "skills mcp"].map((label) => label.toLowerCase());
  const chromeLabels = [chromeMcpAppLabel, "chrome browser", "chrome mcp"].map((label) => label.toLowerCase());
  return {
    skillsPresent: skillsLabels.some((label) => normalized.includes(label)),
    chromePresent: chromeLabels.some((label) => normalized.includes(label)),
  };
}

async function openAppPicker(page) {
  const buttonPatterns = [/tools/i, /apps/i, /add files/i, /attach/i, /more/i];
  for (const pattern of buttonPatterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if ((await locator.count()) > 0 && (await locator.isVisible()).valueOf()) {
      await locator.click();
      return;
    }
  }
}

async function requireAuthenticatedChatGpt(page) {
  try {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.AUTH,
      "ChatGPT could not be opened in the dedicated profile; verify network access and authentication, then retry.",
      { cause: error },
    );
  }
  if (/\/(auth|login|signup)(\/|$)/i.test(new URL(page.url()).pathname)) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.AUTH,
      "The dedicated live-smoke Chrome profile is not authenticated to ChatGPT. Run the bootstrap entry point and sign in manually.",
    );
  }
  const composer = page.locator("#prompt-textarea, textarea, [contenteditable='true']").first();
  try {
    await composer.waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.AUTH,
      "ChatGPT did not expose an authenticated composer in the dedicated profile. Complete sign-in manually and retry.",
      { cause: error },
    );
  }
}

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
  if (!apps.skillsPresent || !apps.chromePresent) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.TUNNEL_APP,
      `ChatGPT app preflight is incomplete: skills-mcp=${apps.skillsPresent}, chrome-mcp=${apps.chromePresent}. Add/enable both apps in this ChatGPT account, using tunnel profile ${config.tunnelProfile} for chrome-mcp.`,
    );
  }
}

async function readRuntimeVersions(root, client) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "dist/extension/manifest.json"), "utf8"));
  const status = await client.callTool({ name: "browser_status", arguments: {} });
  if (status.isError) {
    throw new LiveSmokeSetupError(LIVE_SMOKE_FAILURE.NATIVE_HOST, "browser_status failed against the isolated MCP bridge");
  }
  const runtime = status.structuredContent;
  if (!runtime || typeof runtime !== "object") {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.NATIVE_HOST,
      "browser_status returned no structured runtime metadata from the isolated MCP bridge",
    );
  }
  const version = assertRuntimeVersions({
    packageVersion: packageJson.version,
    manifestVersion: manifest.version,
    extensionId: runtime.extensionId,
    extensionVersion: runtime.extensionVersion,
    mcpVersion: runtime.mcpVersion,
  });
  return { version, runtime };
}

async function requireExpectedTools(client) {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  const missing = ["browser_status", "list_tabs", "read_tab", "spawn_agents", "collect_agents", "cancel_agents"].filter(
    (name) => !names.has(name),
  );
  if (missing.length > 0) {
    throw new LiveSmokeSetupError(
      LIVE_SMOKE_FAILURE.STALE_BUILD_ARTIFACTS,
      `The isolated MCP bridge is missing expected tools: ${missing.join(", ")}`,
    );
  }
  return tools.tools.length;
}

export async function startLiveChatGptEnvironment({ root, env = process.env, verifyArtifacts = true } = {}) {
  const resolvedRoot = resolve(root ?? join(import.meta.dirname, "../../.."));
  const config = loadLiveSmokeConfig({ env, root: resolvedRoot });
  if (verifyArtifacts) verifyCommittedRuntimeArtifacts(resolvedRoot);

  const canary = await fetchCanaryRef(config.canary, env.GITHUB_TOKEN);
  let stack;
  let client;
  let tunnel;
  let closed = false;
  try {
    try {
      stack = await startChromeMcpStack({
        root: resolvedRoot,
        homeDir: config.userHome,
        profileDir: config.profileDir,
        chromePath: config.chromePath,
        requireGoogleChrome: true,
        noSandbox: false,
        mcpPort: config.mcpPort,
        provisionNativeHost: false,
        initialUrl: "about:blank",
      });
    } catch (error) {
      throw classifyStackFailure(error);
    }

    client = new Client({ name: "chrome-live-chatgpt-preflight", version: "1.0.0" });
    let toolCount;
    let version;
    let runtime;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl)));
      toolCount = await requireExpectedTools(client);
      ({ version, runtime } = await readRuntimeVersions(resolvedRoot, client));
    } catch (error) {
      if (error instanceof LiveSmokeSetupError) throw error;
      throw new LiveSmokeSetupError(
        LIVE_SMOKE_FAILURE.NATIVE_HOST,
        `The isolated MCP bridge could not complete its direct preflight: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    runTunnelDoctor(config.tunnelProfile, stack.mcpUrl, resolvedRoot);
    tunnel = await startTunnel(config.tunnelProfile, stack.mcpUrl, resolvedRoot);

    const cdp = await stack.browser.newBrowserCDPSession();
    const chromeVersion = await cdp.send("Browser.getVersion");
    await cdp.detach();

    const report = {
      profileDir: config.profileDir,
      endpoint: stack.mcpUrl,
      tunnelProfile: config.tunnelProfile,
      extensionId: runtime.extensionId,
      toolCount,
      versions: {
        chrome: chromeVersion.product,
        extension: runtime.extensionVersion,
        nativeBridge: runtime.mcpVersion,
        mcpRuntime: version,
      },
      canary,
    };

    const preflightChatGpt = async ({ bootstrap = false } = {}) => {
      if (tunnel.exitCode !== null) {
        throw new LiveSmokeSetupError(
          LIVE_SMOKE_FAILURE.TUNNEL_APP,
          `tunnel-client is no longer running for profile ${config.tunnelProfile}`,
        );
      }
      let page = stack.context.pages().find((candidate) => candidate.url().startsWith("https://chatgpt.com/"));
      if (!page) page = await stack.context.newPage();
      await page.bringToFront();
      if (!bootstrap) {
        await requireAuthenticatedChatGpt(page);
        await requireChatGptApps(page, config);
      } else {
        await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      return page;
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      await client?.close().catch(() => undefined);
      await stopTunnel(tunnel);
      await stack?.close();
    };

    return { config, report, stack, preflightChatGpt, close };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await stopTunnel(tunnel);
    await stack?.close();
    throw error;
  }
}

export async function removeLiveSmokeProfile(profileDir) {
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
