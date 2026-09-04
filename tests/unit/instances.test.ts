import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { instances } = JSON.parse(
  readFileSync(new URL("../../scripts/instances.json", import.meta.url), "utf8"),
) as {
  instances: Array<{
    name: string;
    port: number;
    hostName: string;
    extensionId: string;
    key: string;
    extensionDir: string;
    wrapper: string;
    tunnelProfile: string;
    runtimeKeyEnv: string;
  }>;
};

function extensionIdForKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((hex) => String.fromCharCode("a".charCodeAt(0) + parseInt(hex, 16))).join("");
}

describe("Chrome instance topology", () => {
  it("declares three isolated instances", () => {
    expect(instances).toHaveLength(3);
    for (const field of ["name", "port", "hostName", "extensionId", "key", "extensionDir", "wrapper", "tunnelProfile", "runtimeKeyEnv"] as const) {
      expect(new Set(instances.map((instance) => instance[field])).size).toBe(3);
    }
  });

  it("pins each extension ID to its manifest key", () => {
    for (const instance of instances) {
      expect(extensionIdForKey(instance.key)).toBe(instance.extensionId);
    }
  });

  it("keeps the primary instance on its stable port and host", () => {
    const [primary] = instances;
    expect(primary?.port).toBe(2091);
    expect(primary?.hostName).toBe("com.komaksym.chrome_browser_mcp");
    expect(primary?.extensionId).toBe("jlpddlfiallighiohmhhkemgbhofpnha");
    expect(primary?.runtimeKeyEnv).toBe("CONTROL_PLANE_API_KEY");
  });

  it("keeps the agent instance on the reserved port and identity", () => {
    const agent = instances.find((instance) => instance.name === "chrome3");
    expect(agent).toMatchObject({
      port: 2095,
      hostName: "com.komaksym.chrome_browser_mcp_3",
      extensionId: "cjfkelmiakmoanljhleaahajdichbemn",
      tunnelProfile: "chrome-browser-mcp-3",
      runtimeKeyEnv: "CONTROL_PLANE_API_KEY_AGENT",
    });
  });
});
