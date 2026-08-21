import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const runtimeArtifacts = ["dist/extension/manifest.json", "dist/extension/background.js", "dist/bridge/index.js"];

describe("pulled runtime artifacts", () => {
  it("tracks the files Chrome and the native host execute", () => {
    for (const artifact of runtimeArtifacts) {
      expect(() => execFileSync("git", ["ls-files", "--error-unmatch", artifact], { stdio: "pipe" })).not.toThrow();
    }
  });
});
