import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

describe("macOS native host installer", () => {
  it("installs a wrapper that launches with Chrome's minimal PATH", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chrome-browser-mcp-install-"));
    const home = join(sandbox, "home");
    const fakeBin = join(sandbox, "fake-bin");
    const captureFile = join(sandbox, "native-host-args.txt");

    mkdirSync(home, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    writeExecutable(join(fakeBin, "uname"), "#!/bin/bash\nprintf 'Darwin\\n'\n");
    writeExecutable(join(fakeBin, "npm"), "#!/bin/bash\nexit 0\n");
    writeExecutable(
      join(fakeBin, "node"),
      `#!/bin/bash\nif [[ \"\${1:-}\" == \"--input-type=module\" ]]; then\n  exec \"$REAL_NODE\" \"$@\"\nfi\nprintf '%s\\n' \"$@\" > \"$CAPTURE_FILE\"\n`,
    );

    try {
      const install = spawnSync("/bin/bash", ["scripts/install-macos.sh"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          REAL_NODE: process.execPath,
        },
        encoding: "utf8",
      });

      expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);

      const manifestPath = join(
        home,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { path: string };
      const installedWrapper = join(
        home,
        "Library/Application Support/Chrome Browser MCP/native-host-wrapper.sh",
      );

      expect(manifest.path).toBe(installedWrapper);
      expect(readFileSync(installedWrapper, "utf8")).not.toContain("/usr/bin/env node");

      const origin = "chrome-extension://jlpddlfiallighiohmhhkemgbhofpnha/";
      const launch = spawnSync(installedWrapper, [origin], {
        cwd: repoRoot,
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          REAL_NODE: process.execPath,
          CAPTURE_FILE: captureFile,
        },
        encoding: "utf8",
      });

      expect(launch.status, `${launch.stdout}\n${launch.stderr}`).toBe(0);
      expect(readFileSync(captureFile, "utf8").trim().split("\n")).toEqual([
        join(repoRoot, "dist/bridge/index.js"),
        origin,
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
