import { describe, expect, it } from "vitest";
import {
  LIVE_SMOKE_FAILURE,
  LiveSmokeSetupError,
  appLabelsPresent,
  assertDedicatedProfilePath,
  assertRuntimeVersions,
  loadLiveSmokeConfig,
  parseCanary,
} from "../e2e/support/live-chatgpt-environment.mjs";
import { EXTENSION_ID } from "../e2e/support/chrome-mcp-stack.mjs";

describe("live ChatGPT smoke environment policy", () => {
  it("defaults to an isolated profile, port, tunnel profile, and canary", () => {
    const config = loadLiveSmokeConfig({ env: {}, root: "/workspace/repo", userHome: "/home/tester" });
    expect(config.profileDir).toBe("/home/tester/.chrome-browser-mcp/live-smoke/chrome-profile");
    expect(config.mcpPort).toBe(2191);
    expect(config.tunnelProfile).toBe("chrome-browser-mcp-live-smoke");
    expect(config.canary).toEqual({ owner: "komaksym", repo: "chrome-browser-mcp", prNumber: 34 });
  });

  it("rejects a live profile inside the repository", () => {
    expect(() =>
      assertDedicatedProfilePath({ profileDir: "/workspace/repo/.profile", root: "/workspace/repo", userHome: "/home/tester" }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.CHROME_PROFILE }));
  });

  it("rejects a normal Chrome profile tree", () => {
    expect(() =>
      assertDedicatedProfilePath({
        profileDir: "/home/tester/.config/google-chrome/Default",
        root: "/workspace/repo",
        userHome: "/home/tester",
      }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.CHROME_PROFILE }));
  });

  it("rejects the normal Chrome MCP endpoint and tunnel profile", () => {
    expect(() =>
      loadLiveSmokeConfig({
        env: { LIVE_CHATGPT_MCP_PORT: "2091" },
        root: "/workspace/repo",
        userHome: "/home/tester",
      }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.ENDPOINT_COLLISION }));
    expect(() =>
      loadLiveSmokeConfig({
        env: { LIVE_CHATGPT_TUNNEL_PROFILE: "chrome-browser-mcp" },
        root: "/workspace/repo",
        userHome: "/home/tester",
      }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.TUNNEL_APP }));
  });

  it("validates the canary syntax", () => {
    expect(parseCanary("owner/repo#123")).toEqual({ owner: "owner", repo: "repo", prNumber: 123 });
    expect(() => parseCanary("owner/repo")).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.CANARY }));
  });

  it("requires one version across package, manifest, extension, and MCP runtime", () => {
    expect(
      assertRuntimeVersions({
        packageVersion: "1.2.3",
        manifestVersion: "1.2.3",
        extensionId: EXTENSION_ID,
        extensionVersion: "1.2.3",
        mcpVersion: "1.2.3",
      }),
    ).toBe("1.2.3");
    expect(() =>
      assertRuntimeVersions({
        packageVersion: "1.2.3",
        manifestVersion: "1.2.2",
        extensionId: EXTENSION_ID,
        extensionVersion: "1.2.3",
        mcpVersion: "1.2.3",
      }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.STALE_BUILD_ARTIFACTS }));
  });

  it("requires the stable extension identity", () => {
    expect(() =>
      assertRuntimeVersions({
        packageVersion: "1.2.3",
        manifestVersion: "1.2.3",
        extensionId: "wrong",
        extensionVersion: "1.2.3",
        mcpVersion: "1.2.3",
      }),
    ).toThrowError(expect.objectContaining({ category: LIVE_SMOKE_FAILURE.EXTENSION }));
  });

  it("recognizes configurable ChatGPT app labels without inspecting page markup", () => {
    expect(
      appLabelsPresent("Skills MCP\nChrome Browser", {
        skillsMcpAppLabel: "skills-mcp",
        chromeMcpAppLabel: "chrome-mcp",
      }),
    ).toEqual({ skillsPresent: true, chromePresent: true });
  });

  it("exposes classified setup errors", () => {
    const error = new LiveSmokeSetupError(LIVE_SMOKE_FAILURE.AUTH, "sign in");
    expect(error.name).toBe("LiveSmokeSetupError");
    expect(error.category).toBe("auth");
  });
});
