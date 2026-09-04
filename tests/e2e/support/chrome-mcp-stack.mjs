import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { chromium } from "@playwright/test";

export const EXTENSION_ID = "jlpddlfiallighiohmhhkemgbhofpnha";
const NATIVE_HOST_NAME = "com.komaksym.chrome_browser_mcp";

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export async function claimLoopbackPort(requestedPort = 0) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not resolve loopback port");
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  }
}

export function defaultNativeHostDirectories(homeDir) {
  return unique([
    process.platform === "darwin"
      ? join(homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts")
      : undefined,
    process.platform === "win32"
      ? undefined
      : join(homeDir, ".config/chromium/NativeMessagingHosts"),
    process.platform === "win32"
      ? undefined
      : join(homeDir, ".config/google-chrome/NativeMessagingHosts"),
    process.platform === "win32"
      ? undefined
      : join(homeDir, ".config/google-chrome-for-testing/NativeMessagingHosts"),
    process.platform === "win32"
      ? undefined
      : join(homeDir, ".config/chrome-for-testing/NativeMessagingHosts"),
  ]);
}

function configuredNativeHostDirectories() {
  return unique([
    process.env.CHROME_NATIVE_HOST_DIR,
    ...(process.env.CHROME_NATIVE_HOST_DIRS?.split(delimiter) ?? []),
  ]);
}

async function installNativeHostManifests({ root, homeDir, nativeHostDirs = [] }) {
  const directories = unique([
    ...configuredNativeHostDirectories(),
    ...nativeHostDirs,
    ...defaultNativeHostDirectories(homeDir),
  ]);
  if (directories.length === 0) {
    throw new Error("No supported native-messaging host directory is available on this platform");
  }

  const paths = directories.map((directory) => join(directory, `${NATIVE_HOST_NAME}.json`));
  const previous = new Map();
  const manifest = `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Chrome Browser MCP E2E host",
      path: join(root, "scripts/native-host-wrapper.sh"),
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`;

  for (const [index, directory] of directories.entries()) {
    const path = paths[index];
    try {
      previous.set(path, await readFile(path, "utf8"));
    } catch {
      previous.set(path, undefined);
    }
    await mkdir(directory, { recursive: true });
    await writeFile(path, manifest);
  }

  return {
    paths,
    async restore() {
      for (const path of paths) {
        const previousManifest = previous.get(path);
        if (previousManifest === undefined) await unlink(path).catch(() => undefined);
        else await writeFile(path, previousManifest);
      }
    },
  };
}

async function findExistingNativeHostManifest({ homeDir, nativeHostDirs = [] }) {
  const directories = unique([
    ...configuredNativeHostDirectories(),
    ...nativeHostDirs,
    ...defaultNativeHostDirectories(homeDir),
  ]);
  const checkedPaths = directories.map((directory) => join(directory, `${NATIVE_HOST_NAME}.json`));
  for (const path of checkedPaths) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
      if (manifest.name !== NATIVE_HOST_NAME) continue;
      if (!origins.includes(`chrome-extension://${EXTENSION_ID}/`)) continue;
      if (typeof manifest.path !== "string" || !existsSync(manifest.path)) continue;
      return { paths: [path], restore: async () => undefined };
    } catch {
      // Keep looking for a valid installed user-level native host.
    }
  }
  throw new Error(
    `No valid installed native host was found. Checked: ${checkedPaths.join(", ")}. Run npm run install:mac from this checkout first.`,
  );
}

export function resolveChromeExecutable({ chromePath, requireGoogleChrome = false } = {}) {
  if (chromePath) {
    if (!existsSync(chromePath)) throw new Error(`Chrome executable does not exist: ${chromePath}`);
    return chromePath;
  }

  const candidates = [];
  if (!requireGoogleChrome) {
    const bundled = chromium.executablePath();
    if (existsSync(bundled)) candidates.push(bundled);
  }
  if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else if (process.platform === "win32") {
    if (process.env.PROGRAMFILES) candidates.push(join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"));
    if (process.env["PROGRAMFILES(X86)"]) {
      candidates.push(join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"));
    }
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"));
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
    if (!requireGoogleChrome) candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser");
  }

  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(requireGoogleChrome ? "Google Chrome executable was not found" : "Chrome/Chromium executable was not found");
  }
  return executable;
}

async function waitForDevTools({ debugUrl, browserProcess, browserErrors, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debugUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    if (browserProcess.exitCode !== null) {
      throw new Error(`Chrome exited early (${browserProcess.exitCode}): ${browserErrors()}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Chrome DevTools did not become ready: ${browserErrors()}`);
}

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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Bridge did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function stopBrowserProcess(browserProcess, profileDir) {
  if (browserProcess && browserProcess.exitCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => browserProcess.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
    ]);
    if (browserProcess.exitCode === null) browserProcess.kill("SIGKILL");
  }
  if (process.platform !== "win32") {
    spawnSync("pkill", ["-TERM", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    spawnSync("pkill", ["-KILL", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
  }
}

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

export async function startChromeMcpStack({
  root,
  homeDir,
  profileDir,
  chromePath,
  requireGoogleChrome = false,
  noSandbox = false,
  mcpPort = 0,
  debugPort = 0,
  nativeHostDirs = [],
  provisionNativeHost = true,
  initialUrl = "about:blank",
  timeoutMs = 20_000,
}) {
  const claimedMcpPort = await claimLoopbackPort(mcpPort);
  let claimedDebugPort = await claimLoopbackPort(debugPort);
  while (claimedDebugPort === claimedMcpPort) claimedDebugPort = await claimLoopbackPort(0);

  let nativeHost;
  let executable;
  let browser;
  let browserProcess;
  let stderr = "";
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await browser?.close().catch(() => undefined);
    if (browserProcess) await stopBrowserProcess(browserProcess, profileDir);
    await nativeHost?.restore();
  };

  try {
    nativeHost = provisionNativeHost
      ? await installNativeHostManifests({ root, homeDir, nativeHostDirs })
      : await findExistingNativeHostManifest({ homeDir, nativeHostDirs });
    executable = resolveChromeExecutable({ chromePath, requireGoogleChrome });
    await mkdir(profileDir, { recursive: true });

    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${claimedDebugPort}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${join(root, "dist/extension")}`,
      `--load-extension=${join(root, "dist/extension")}`,
      initialUrl,
    ];
    if (noSandbox) args.unshift("--no-sandbox");

    browserProcess = spawn(executable, args, {
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        CHROME_MCP_PORT: String(claimedMcpPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    browserProcess.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
    });

    const debugUrl = `http://127.0.0.1:${claimedDebugPort}`;
    await waitForDevTools({ debugUrl, browserProcess, browserErrors: () => stderr, timeoutMs });
    browser = await chromium.connectOverCDP(debugUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Expected Chrome default browser context");

    try {
      await waitForBridgeReady(`http://127.0.0.1:${claimedMcpPort}/healthz`, timeoutMs);
    } catch (error) {
      const diagnostics = await bridgeDiagnostics(context);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nNative host manifests: ${JSON.stringify(nativeHost.paths)}\nService workers: ${JSON.stringify(diagnostics)}\nChrome logs: ${stderr}`,
      );
    }

    return {
      browser,
      browserProcess,
      chromePath: executable,
      context,
      debugPort: claimedDebugPort,
      debugUrl,
      extensionId: EXTENSION_ID,
      mcpPort: claimedMcpPort,
      mcpUrl: `http://127.0.0.1:${claimedMcpPort}/mcp`,
      nativeHostPaths: nativeHost.paths,
      profileDir,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
