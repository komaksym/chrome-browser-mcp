import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("extension version", () => {
  it("uses package.json as the generated manifest version", () => {
    execFileSync(process.execPath, ["scripts/build-extension.mjs"], { cwd: root, stdio: "pipe" });
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const manifest = JSON.parse(readFileSync(new URL("../../dist/extension/manifest.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const secondManifest = JSON.parse(
      readFileSync(new URL("../../dist/extension2/manifest.json", import.meta.url), "utf8"),
    ) as { version: string };
    const thirdManifest = JSON.parse(
      readFileSync(new URL("../../dist/extension3/manifest.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(packageJson.version);
    expect(secondManifest.version).toBe(packageJson.version);
    expect(thirdManifest.version).toBe(packageJson.version);
  });
});
