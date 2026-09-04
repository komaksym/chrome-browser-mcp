import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export const EXTENSION_ID = "jlpddlfiallighiohmhhkemgbhofpnha";
const NATIVE_HOST_NAME = "com.komaksym.chrome_browser_mcp";
const RESERVED_MCP_PORTS = new Set([2091, 2093]);

/** Returns unique non-empty strings while preserving their first-seen order. */
function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

/** Claims a loopback port and immediately releases it for the child process. */
async function claimLoopbackPort(requestedPort = 0) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not resolve loopback port");
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

/** Returns the per-user native-host directory for the Google Chrome executable used by this runner. */
export function defaultNativeHostDirectories(homeDir) {
  if (process.platform === "darwin") {
    return [join(homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts")];
  }
  if (process.platform === "win32") return [];
  return [join(homeDir, ".config/google-chrome/NativeMessagingHosts")];
}

/** Installs temporary native-host manifests and returns an idempotent restoration function. */
async function installNativeHostManifests({ root, homeDir, nativeHostDirs = [], nativeHostName }) {
  const directories = unique([...nativeHostDirs, ...defaultNativeHostDirectories(homeDir)]);
  if (directories.length === 0) throw new Error("No supported native-messaging host directory is available");

  const paths = directories.map((directory) => join(directory, `${nativeHostName}.json`));
  const previous = new Map();
  const manifest = `${JSON.stringify(
    {
      name: nativeHostName,
      description: "Chrome Browser MCP live E2E host",
      path: join(root, "scripts/native-host-wrapper.sh"),
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`;

  /** Restores only the native-host manifests touched by this test run. */
  const restore = async () => {
    for (const path of paths) {
      const previousManifest = previous.get(path);
      if (previousManifest === undefined) await unlink(path).catch(() => undefined);
      else await writeFile(path, previousManifest);
    }
  };

  const touched = [];
  try {
    for (const [index, directory] of directories.entries()) {
      const path = paths[index];
      try {
        previous.set(path, await readFile(path, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        previous.set(path, undefined);
      }
      touched.push(path);
      await mkdir(directory, { recursive: true });
      await writeFile(path, manifest);
    }
  } catch (error) {
    for (const path of touched) {
      const previousManifest = previous.get(path);
      if (previousManifest === undefined) await unlink(path).catch(() => undefined);
      else await writeFile(path, previousManifest).catch(() => undefined);
    }
    throw error;
  }
  return { paths, restore };
}

/** Copies the built extension and rewrites only its native-host name for this isolated run. */
async function createIsolatedExtension({ root, homeDir, nativeHostName }) {
  const extensionDir = join(homeDir, "extension");
  await cp(join(root, "dist/extension"), extensionDir, { recursive: true, errorOnExist: true });
  const backgroundPath = join(extensionDir, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  if (!background.includes(NATIVE_HOST_NAME)) {
    throw new Error("The built extension does not contain the expected native-host name");
  }
  await writeFile(backgroundPath, background.replaceAll(NATIVE_HOST_NAME, nativeHostName));
  return extensionDir;
}

/** Resolves a real Chrome executable, honoring an explicit test configuration. */
export function resolveChromeExecutable(chromePath) {
  if (chromePath) {
    if (!existsSync(chromePath)) throw new Error(`Chrome executable does not exist: ${chromePath}`);
    return chromePath;
  }

  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else if (process.platform === "win32") {
    if (process.env.PROGRAMFILES) candidates.push(join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"));
    if (process.env["PROGRAMFILES(X86)"]) {
      candidates.push(join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"));
    }
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
  }

  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Google Chrome executable was not found");
  return executable;
}

/** Waits until Chrome exposes its CDP endpoint or exits with a bounded diagnostic. */
async function waitForDevTools({ debugUrl, browserProcess, getBrowserErrors, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debugUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    if (browserProcess.exitCode !== null) {
      throw new Error(`Chrome exited early (${browserProcess.exitCode}): ${getBrowserErrors()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome DevTools did not become ready: ${getBrowserErrors()}`);
}

/** Waits for the isolated MCP bridge to report a connected extension. */
export async function waitForBridgeReady(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json();
        if (body.browser?.connected) return body;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Bridge did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

/** Escapes a profile path before using it in a process-matching cleanup command. */
export function profileProcessPattern(profileDir) {
  return `--user-data-dir=${profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}

/** Returns whether an incoming HTTP URL uses the current run's MCP endpoint path. */
export function isExpectedMcpPath(requestUrl, mcpPath) {
  try {
    return new URL(requestUrl ?? "/", "http://127.0.0.1").pathname === mcpPath;
  } catch {
    return false;
  }
}

/** Records tool-call metadata from one proxied MCP JSON-RPC request without retaining its arguments. */
export function recordMcpTraffic({
  phase,
  requestBody,
  traffic,
  expectedRunId = null,
  expectedAxisMarkers = [],
}) {
  let payload;
  try {
    payload = JSON.parse(requestBody);
  } catch {
    return;
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  for (const request of requests) {
    if (request?.method !== "tools/call" || typeof request.params?.name !== "string") continue;
    const argumentsValue = request.params.arguments;
    const tasks = argumentsValue && typeof argumentsValue === "object" && Array.isArray(argumentsValue.tasks)
      ? argumentsValue.tasks
      : null;
    const prompts = tasks?.map((task) => (typeof task?.prompt === "string" ? task.prompt : "")) ?? null;
    const observedAxisMarkers =
      prompts && expectedAxisMarkers.length > 0
        ? expectedAxisMarkers.filter((marker) => prompts.some((prompt) => prompt.includes(marker)))
        : [];
    const axisPromptMarkerTaskCounts = prompts
      ? expectedAxisMarkers.map((marker) => prompts.filter((prompt) => prompt.includes(marker)).length)
      : null;
    const axisPromptMarkerTaskIndexes = prompts
      ? expectedAxisMarkers.map((marker) => prompts.findIndex((prompt) => prompt.includes(marker)))
      : null;
    const runIdPromptCount =
      prompts && typeof expectedRunId === "string" && expectedRunId.length > 0
        ? prompts.filter((prompt) => prompt.includes(expectedRunId)).length
        : null;
    const spawnShape = request.params.name === "spawn_agents" && argumentsValue && typeof argumentsValue === "object"
        ? {
          axisPromptMarkerCount: prompts ? observedAxisMarkers.length : null,
          axisPromptMarkerTaskCounts,
          axisPromptMarkerTaskIndexes,
          distinctAgentIdCount: tasks
            ? new Set(tasks.map((task) => task?.agent_id).filter((agentId) => typeof agentId === "string"))
                .size
            : null,
          maxConcurrency: argumentsValue.max_concurrency ?? null,
          nonEmptyPromptCount: tasks
            ? tasks.filter((task) => typeof task?.prompt === "string" && task.prompt.length > 0).length
            : null,
          promptCount: tasks
            ? tasks.filter((task) => typeof task?.prompt === "string").length
            : null,
          runIdPromptCount,
          taskCount: tasks?.length ?? null,
        }
      : {};
    traffic.push({
      method: request.method,
      name: request.params.name,
      phase,
      timestamp: Date.now(),
      ...spawnShape,
    });
  }
}

/** Starts a streaming HTTP proxy so the live test can prove which MCP tools the parent invoked. */
async function startMcpTrafficProxy({ listenPort, targetPort, mcpPath }) {
  const traffic = [];
  let phase = "setup";
  let expectedRunId = null;
  let expectedAxisMarkers = [];
  const server = createServer((incoming, outgoing) => {
    if (!isExpectedMcpPath(incoming.url, mcpPath)) {
      outgoing.writeHead(404);
      outgoing.end("MCP endpoint not found");
      return;
    }
    const incomingUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    let size = 0;
    incoming.on("data", (chunk) => {
      if (size < 1_000_000) chunks.push(chunk);
      size += chunk.length;
    });
    incoming.on("end", () => {
      recordMcpTraffic({
        expectedAxisMarkers,
        expectedRunId,
        phase,
        requestBody: Buffer.concat(chunks).toString("utf8"),
        traffic,
      });
    });

    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        method: incoming.method,
        path: `/mcp${incomingUrl.search}`,
        headers: { ...incoming.headers, host: `127.0.0.1:${targetPort}` },
        agent: false,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.once("error", () => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
        outgoing.end("MCP proxy target unavailable");
      } else {
        outgoing.destroy();
      }
    });
    incoming.pipe(upstream);
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolvePromise);
  });

  return {
    close: async () => {
      if (!server.listening) return;
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
    mcpUrl: `http://127.0.0.1:${listenPort}${mcpPath}`,
    setPhase: (nextPhase, options = {}) => {
      phase = nextPhase;
      expectedRunId = options.expectedRunId ?? null;
      expectedAxisMarkers = options.expectedAxisMarkers ?? [];
    },
    traffic,
  };
}

/** Stops only the browser process associated with the isolated profile. */
async function stopBrowserProcess(browserProcess, profileDir) {
  if (browserProcess && browserProcess.exitCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browserProcess.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (browserProcess.exitCode === null) browserProcess.kill("SIGKILL");
  }
  if (process.platform !== "win32") {
    const pattern = profileProcessPattern(profileDir);
    spawnSync("pkill", ["-TERM", "-f", pattern], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    spawnSync("pkill", ["-KILL", "-f", pattern], { stdio: "ignore" });
  }
}

/** Reads only bounded extension-service-worker diagnostics after bridge startup fails. */
async function bridgeDiagnostics(context) {
  return Promise.all(
    context.serviceWorkers().map(async (worker) => {
      let lastNativeError = null;
      if (worker.url().startsWith(`chrome-extension://${EXTENSION_ID}/`)) {
        try {
          lastNativeError = await worker.evaluate(() => globalThis.__chromeBrowserMcpLastNativeError ?? null);
        } catch (error) {
          lastNativeError = `Could not read extension diagnostic: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return { url: worker.url(), lastNativeError };
    }),
  );
}

/** Starts the real headed Chrome/native-host/MCP stack used by the live smoke test. */
export async function startChromeMcpStack({
  root,
  homeDir,
  profileDir,
  chromePath,
  mcpPort,
  debugPort = 0,
  nativeHostDirs = [],
  noSandbox = false,
  initialUrl = "about:blank",
  timeoutMs = 20_000,
  onSignal,
}) {
  const claimedMcpPort = await claimLoopbackPort(mcpPort);
  let claimedDebugPort = await claimLoopbackPort(debugPort);
  while (claimedDebugPort === claimedMcpPort) claimedDebugPort = await claimLoopbackPort(0);

  let nativeHost;
  let mcpProxy;
  let extensionDir;
  let browser;
  let browserProcess;
  let browserErrors = "";
  let closed = false;
  let signalHandled = false;
  let signalHandler;

  /** Removes the signal hooks installed for this run-owned stack. */
  const detachSignals = () => {
    if (!signalHandler) return;
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    signalHandler = undefined;
  };

  /** Closes this stack once and restores only the manifests it installed. */
  const close = async () => {
    if (closed) return;
    closed = true;
    detachSignals();
    await browser?.close().catch(() => undefined);
    if (browserProcess) await stopBrowserProcess(browserProcess, profileDir);
    await mcpProxy?.close().catch(() => undefined);
    await nativeHost?.restore();
  };

  try {
    const nativeHostName = `${NATIVE_HOST_NAME}_live_${randomUUID().replaceAll("-", "")}`;
    nativeHost = await installNativeHostManifests({ root, homeDir, nativeHostDirs, nativeHostName });
    signalHandler = (signal) => {
      if (signalHandled) return;
      signalHandled = true;
      void close().finally(() => {
        if (onSignal) onSignal(signal);
        else process.exit(signal === "SIGINT" ? 130 : 143);
      });
    };
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    extensionDir = await createIsolatedExtension({ root, homeDir, nativeHostName });
    const executable = resolveChromeExecutable(chromePath);
    let bridgePort = await claimLoopbackPort(0);
    while (bridgePort === claimedMcpPort || RESERVED_MCP_PORTS.has(bridgePort)) {
      bridgePort = await claimLoopbackPort(0);
    }
    await mkdir(profileDir, { recursive: true });
    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${claimedDebugPort}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      initialUrl,
    ];
    if (noSandbox) args.unshift("--no-sandbox");

    browserProcess = spawn(executable, args, {
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        CHROME_MCP_PORT: String(bridgePort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    browserProcess.stderr.on("data", (chunk) => {
      browserErrors = `${browserErrors}${chunk.toString()}`.slice(-16_000);
    });

    const debugUrl = `http://127.0.0.1:${claimedDebugPort}`;
    await waitForDevTools({ debugUrl, browserProcess, getBrowserErrors: () => browserErrors, timeoutMs });
    browser = await chromium.connectOverCDP(debugUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Expected Chrome default browser context");

    try {
      await waitForBridgeReady(`http://127.0.0.1:${bridgePort}/healthz`, timeoutMs);
    } catch (error) {
      const diagnostics = await bridgeDiagnostics(context);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nNative host manifests: ${JSON.stringify(nativeHost.paths)}\nService workers: ${JSON.stringify(diagnostics)}\nChrome logs: ${browserErrors}`,
      );
    }

    const mcpPath = `/mcp/live/${randomUUID()}`;
    mcpProxy = await startMcpTrafficProxy({ listenPort: claimedMcpPort, targetPort: bridgePort, mcpPath });

    return {
      browser,
      context,
      bridgeMcpUrl: `http://127.0.0.1:${bridgePort}/mcp`,
      mcpTraffic: mcpProxy.traffic,
      mcpPort: claimedMcpPort,
      mcpUrl: mcpProxy.mcpUrl,
      setMcpTrafficPhase: mcpProxy.setPhase,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
