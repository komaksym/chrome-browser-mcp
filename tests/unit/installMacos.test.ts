import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const instances = [
  {
    manifest: "com.komaksym.chrome_browser_mcp.json",
    wrapper: "native-host-wrapper.sh",
    origin: "chrome-extension://jlpddlfiallighiohmhhkemgbhofpnha/",
    port: "2091",
  },
  {
    manifest: "com.komaksym.chrome_browser_mcp_2.json",
    wrapper: "native-host-wrapper-2.sh",
    origin: "chrome-extension://doommfidfcljgehkppgiinjdjnafcmdc/",
    port: "2093",
  },
  {
    manifest: "com.komaksym.chrome_browser_mcp_3.json",
    wrapper: "native-host-wrapper-3.sh",
    origin: "chrome-extension://cjfkelmiakmoanljhleaahajdichbemn/",
    port: "2095",
  },
];

describe("macOS native host installer", () => {
  it("installs one isolated wrapper and manifest per Chrome instance", () => {
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
      "#!/bin/bash\n" +
        "if [[ \"\${1:-}\" == \"--input-type=module\" ]]; then\n" +
        "  exec \"$REAL_NODE\" \"$@\"\n" +
        "fi\n" +
        "printf '%s\\n' \"$@\" > \"$CAPTURE_FILE\"\n",
    );

    try {
      const install = spawnSync("/bin/bash", ["scripts/install-macos.sh"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          PATH: fakeBin + ":/usr/bin:/bin",
          REAL_NODE: process.execPath,
        },
        encoding: "utf8",
      });

      expect(install.status, install.stdout + "\n" + install.stderr).toBe(0);
      const topology = JSON.parse(
        readFileSync(join(home, "Library/Application Support/Chrome Browser MCP/instances.json"), "utf8"),
      ) as { instances: unknown[] };
      expect(topology.instances).toHaveLength(3);

      for (const instance of instances) {
        const manifestPath = join(
          home,
          "Library/Application Support/Google/Chrome/NativeMessagingHosts",
          instance.manifest,
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          path: string;
          allowed_origins: string[];
        };
        const installedWrapper = join(
          home,
          "Library/Application Support/Chrome Browser MCP",
          instance.wrapper,
        );

        expect(manifest.path).toBe(installedWrapper);
        expect(manifest.allowed_origins).toEqual([instance.origin]);
        const wrapperContent = readFileSync(installedWrapper, "utf8");
        expect(wrapperContent).not.toContain("/usr/bin/env node");
        expect(wrapperContent).toContain("CHROME_MCP_PORT=\"" + instance.port + "\"");
        expect(wrapperContent).toContain("CHROME_MCP_EXPECTED_ORIGIN=\"" + instance.origin + "\"");
        expect(wrapperContent).toContain(
          "# chrome-browser-mcp-bridge-base64: " + Buffer.from(join(repoRoot, "dist/bridge/index.js")).toString("base64"),
        );

        const launch = spawnSync(installedWrapper, [instance.origin], {
          cwd: repoRoot,
          env: {
            HOME: home,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            REAL_NODE: process.execPath,
            CAPTURE_FILE: captureFile,
          },
          encoding: "utf8",
        });

        expect(launch.status, launch.stdout + "\n" + launch.stderr).toBe(0);
        expect(readFileSync(captureFile, "utf8").trim().split("\n")).toEqual([
          join(repoRoot, "dist/bridge/index.js"),
          instance.origin,
        ]);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uninstalls only the native-host files owned by this topology", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chrome-browser-mcp-uninstall-"));
    const home = join(sandbox, "home");
    const manifestDir = join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts");
    const appDir = join(home, "Library/Application Support/Chrome Browser MCP");
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    try {
      for (const instance of instances) {
        writeFileSync(join(manifestDir, instance.manifest), "owned\n");
        writeFileSync(join(appDir, instance.wrapper), "owned\n");
      }
      writeFileSync(join(manifestDir, "com.komaksym.chrome_browser_mcp_backup.json"), "unmanaged\n");
      writeFileSync(join(appDir, "native-host-wrapper-extra.sh"), "unmanaged\n");
      writeFileSync(join(appDir, "instances.json"), "owned\n");

      const uninstall = spawnSync("/bin/bash", ["scripts/uninstall-macos.sh"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });

      expect(uninstall.status, uninstall.stdout + "\n" + uninstall.stderr).toBe(0);
      for (const instance of instances) {
        expect(existsSync(join(manifestDir, instance.manifest))).toBe(false);
        expect(existsSync(join(appDir, instance.wrapper))).toBe(false);
      }
      expect(existsSync(join(appDir, "instances.json"))).toBe(false);
      expect(existsSync(join(manifestDir, "com.komaksym.chrome_browser_mcp_backup.json"))).toBe(true);
      expect(existsSync(join(appDir, "native-host-wrapper-extra.sh"))).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
