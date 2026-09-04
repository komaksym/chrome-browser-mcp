import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { startChromeMcpStack } from "../e2e/support/chrome-mcp-stack.mjs";

const NATIVE_HOST_NAME = "com.komaksym.chrome_browser_mcp";

describe("startChromeMcpStack", () => {
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
});
