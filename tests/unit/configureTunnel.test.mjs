import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function writeExecutable(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

describe("configure-tunnel instance routing", () => {
  it("derives the agent profile, port, and runtime key reference", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chrome-browser-mcp-configure-"));
    const fakeBin = join(sandbox, "bin");
    const capture = join(sandbox, "tunnel-args.txt");
    const nodeBinDir = dirname(process.execPath);
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, "tunnel-client"),
      ["#!/bin/bash", "printf '%s\\n' \"$@\" > \"$CAPTURE_FILE\""].join("\n"),
    );

    try {
      const result = spawnSync("bash", ["scripts/configure-tunnel.sh", tunnelId, "chrome3"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${nodeBinDir}:/usr/bin:/bin`,
          CAPTURE_FILE: capture,
        },
        encoding: "utf8",
      });

      expect(result.status, [result.stdout, result.stderr].join("\n")).toBe(0);
      const args = readFileSync(capture, "utf8");
      expect(args).toContain(["--profile", "chrome-browser-mcp-3", ""].join("\n"));
      expect(args).toContain(["--mcp-server-url", "http://127.0.0.1:2095/mcp", ""].join("\n"));
      expect(args).toContain(["--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY_AGENT", ""].join("\n"));
      expect(result.stdout).toContain("chrome3");
      expect(result.stdout).toContain("2095");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("forwards --force when replacing an existing profile", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chrome-browser-mcp-configure-force-"));
    const fakeBin = join(sandbox, "bin");
    const capture = join(sandbox, "tunnel-args.txt");
    const nodeBinDir = dirname(process.execPath);
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    const newline = String.fromCharCode(10);
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, "tunnel-client"),
      ["#!/bin/bash", "printf '%s\\n' \"$@\" > \"$CAPTURE_FILE\""].join(newline),
    );

    try {
      const result = spawnSync("bash", ["scripts/configure-tunnel.sh", tunnelId, "chrome2", "--force"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${nodeBinDir}:/usr/bin:/bin`,
          CAPTURE_FILE: capture,
        },
        encoding: "utf8",
      });

      expect(result.status, [result.stdout, result.stderr].join(newline)).toBe(0);
      const args = readFileSync(capture, "utf8");
      expect(args).toContain(["--profile", "chrome-browser-mcp-2", ""].join(newline));
      expect(args).toContain(["--force", ""].join(newline));
      expect(args).toContain(["--mcp-server-url", "http://127.0.0.1:2093/mcp", ""].join(newline));
      expect(result.stdout).toContain("replaced");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a tunnel-like profile name instead of accepting arbitrary routing", () => {
    const result = spawnSync("bash", [
      "scripts/configure-tunnel.sh",
      "tunnel_0123456789abcdef0123456789abcdef",
      "chrome-browser-mcp-2",
    ], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect([result.stdout, result.stderr].join("\n")).toContain(
      "Unknown Chrome instance: chrome-browser-mcp-2",
    );
  });

  it("rejects the old arbitrary profile and URL argument shape", () => {
    const result = spawnSync("bash", [
      "scripts/configure-tunnel.sh",
      "tunnel_0123456789abcdef0123456789abcdef",
      "chrome2",
      "http://127.0.0.1:2093/mcp",
    ], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect([result.stdout, result.stderr].join("\n")).toContain("Usage:");
  });
});
