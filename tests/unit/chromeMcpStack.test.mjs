import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { profileProcessPattern, startChromeMcpStack } from "../e2e/support/chrome-mcp-stack.mjs";

const NATIVE_HOST_NAME = "com.komaksym.chrome_browser_mcp";

describe("startChromeMcpStack", () => {
  it("escapes configurable profile paths before using them as pkill regexes", () => {
    expect(profileProcessPattern("/tmp/live.*[x](test)$")).toBe(
      String.raw`--user-data-dir=/tmp/live\.\*\[x\]\(test\)\$`,
    );
  });

  it("reuses only a standard native host installed from the current checkout", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chrome-mcp-stack-existing-host-"));
    const root = join(sandbox, "current-checkout");
    const homeDir = join(sandbox, "home");
    const standardNativeHostDir =
      process.platform === "darwin"
        ? join(homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts")
        : join(homeDir, ".config/google-chrome/NativeMessagingHosts");
    const configuredNativeHostDir = join(sandbox, "configured-native-hosts");
    const oldNativeHostDir = process.env.CHROME_NATIVE_HOST_DIR;
    const oldNativeHostDirs = process.env.CHROME_NATIVE_HOST_DIRS;

    const writeInstalledHost = async (directory, bridgeEntry) => {
      await mkdir(directory, { recursive: true });
      const wrapperPath = join(directory, "native-host-wrapper.sh");
      await writeFile(
        wrapperPath,
        `#!/bin/bash\n# chrome-browser-mcp-bridge-base64: ${Buffer.from(bridgeEntry).toString("base64")}\n`,
      );
      await writeFile(
        join(directory, `${NATIVE_HOST_NAME}.json`),
        `${JSON.stringify({
          name: NATIVE_HOST_NAME,
          path: wrapperPath,
          type: "stdio",
          allowed_origins: ["chrome-extension://jlpddlfiallighiohmhhkemgbhofpnha/"],
        })}\n`,
      );
    };

    try {
      await writeInstalledHost(
        standardNativeHostDir,
        join(sandbox, "other-checkout", "dist/bridge/index.js"),
      );
      await writeInstalledHost(configuredNativeHostDir, join(root, "dist/bridge/index.js"));
      process.env.CHROME_NATIVE_HOST_DIR = configuredNativeHostDir;
      delete process.env.CHROME_NATIVE_HOST_DIRS;

      await expect(
        startChromeMcpStack({
          root,
          homeDir,
          profileDir: join(sandbox, "profile"),
          chromePath: join(sandbox, "missing-chrome"),
          provisionNativeHost: false,
        }),
      ).rejects.toThrow(/current checkout/);
    } finally {
      if (oldNativeHostDir === undefined) delete process.env.CHROME_NATIVE_HOST_DIR;
      else process.env.CHROME_NATIVE_HOST_DIR = oldNativeHostDir;
      if (oldNativeHostDirs === undefined) delete process.env.CHROME_NATIVE_HOST_DIRS;
      else process.env.CHROME_NATIVE_HOST_DIRS = oldNativeHostDirs;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("restores native-host registration when startup fails after provisioning", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chrome-mcp-stack-cleanup-"));
    const homeDir = join(sandbox, "home");
    const nativeHostDir = join(sandbox, "native-hosts");
    const manifestPath = join(nativeHostDir, `${NATIVE_HOST_NAME}.json`);
    const originalManifest = '{"sentinel":"keep-me"}\n';
    const oldNativeHostDir = process.env.CHROME_NATIVE_HOST_DIR;
    const oldNativeHostDirs = process.env.CHROME_NATIVE_HOST_DIRS;

    delete process.env.CHROME_NATIVE_HOST_DIR;
    delete process.env.CHROME_NATIVE_HOST_DIRS;

    try {
      await mkdir(nativeHostDir, { recursive: true });
      await writeFile(manifestPath, originalManifest);

      await expect(
        startChromeMcpStack({
          root: sandbox,
          homeDir,
          profileDir: join(sandbox, "profile"),
          chromePath: join(sandbox, "missing-chrome"),
          nativeHostDirs: [nativeHostDir],
          provisionNativeHost: true,
        }),
      ).rejects.toThrow(/Chrome executable does not exist/);

      expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
    } finally {
      if (oldNativeHostDir === undefined) delete process.env.CHROME_NATIVE_HOST_DIR;
      else process.env.CHROME_NATIVE_HOST_DIR = oldNativeHostDir;
      if (oldNativeHostDirs === undefined) delete process.env.CHROME_NATIVE_HOST_DIRS;
      else process.env.CHROME_NATIVE_HOST_DIRS = oldNativeHostDirs;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("restores earlier native-host registrations when provisioning fails partway", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chrome-mcp-stack-partial-cleanup-"));
    const homeDir = join(sandbox, "home");
    const nativeHostDir = join(sandbox, "native-hosts");
    const blockedNativeHostDir = join(sandbox, "not-a-directory");
    const manifestPath = join(nativeHostDir, `${NATIVE_HOST_NAME}.json`);
    const originalManifest = '{"sentinel":"keep-me-too"}\n';
    const oldNativeHostDir = process.env.CHROME_NATIVE_HOST_DIR;
    const oldNativeHostDirs = process.env.CHROME_NATIVE_HOST_DIRS;

    delete process.env.CHROME_NATIVE_HOST_DIR;
    delete process.env.CHROME_NATIVE_HOST_DIRS;

    try {
      await mkdir(nativeHostDir, { recursive: true });
      await writeFile(manifestPath, originalManifest);
      await writeFile(blockedNativeHostDir, "block mkdir");

      await expect(
        startChromeMcpStack({
          root: sandbox,
          homeDir,
          profileDir: join(sandbox, "profile"),
          chromePath: join(sandbox, "missing-chrome"),
          nativeHostDirs: [nativeHostDir, blockedNativeHostDir],
          provisionNativeHost: true,
        }),
      ).rejects.toThrow();

      expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
    } finally {
      if (oldNativeHostDir === undefined) delete process.env.CHROME_NATIVE_HOST_DIR;
      else process.env.CHROME_NATIVE_HOST_DIR = oldNativeHostDir;
      if (oldNativeHostDirs === undefined) delete process.env.CHROME_NATIVE_HOST_DIRS;
      else process.env.CHROME_NATIVE_HOST_DIRS = oldNativeHostDirs;
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
