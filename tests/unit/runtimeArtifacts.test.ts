import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { instances } = JSON.parse(
  readFileSync(new URL("../../scripts/instances.json", import.meta.url), "utf8"),
) as { instances: Array<{ extensionDir: string }> };
const runtimeArtifacts = [
  ...instances.flatMap(({ extensionDir }) => [
    `${extensionDir}/manifest.json`,
    `${extensionDir}/background.js`,
  ]),
  "dist/bridge/index.js",
];

describe("pulled runtime artifacts", () => {
  it("tracks the files Chrome and the native host execute", () => {
    for (const artifact of runtimeArtifacts) {
      expect(() => execFileSync("git", ["ls-files", "--error-unmatch", artifact], { stdio: "pipe" })).not.toThrow();
    }
  });
});
