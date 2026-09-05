import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { instances } = JSON.parse(
  readFileSync(new URL("../../scripts/instances.json", import.meta.url), "utf8"),
) as { instances: Array<{ extensionDir: string }> };

describe("extension version", () => {
  it("uses package.json as the generated manifest version", () => {
    execFileSync(process.execPath, ["scripts/build-extension.mjs"], { cwd: root, stdio: "pipe" });
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    for (const { extensionDir } of instances) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../${extensionDir}/manifest.json`, import.meta.url), "utf8"),
      ) as { version: string };
      expect(manifest.version).toBe(packageJson.version);
    }
  });
});
