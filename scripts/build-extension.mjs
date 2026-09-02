import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["src/extension/background.ts"],
  outfile: "dist/extension/background.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome121",
  sourcemap: true,
});
const manifest = {
  manifest_version: 3,
  name: "Chrome Browser MCP",
  version,
  description: "Local Chrome read/write access for a private ChatGPT MCP app.",
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsN2PDxGGdi4kzCaNghCrqsG9k12qKj5zfmHsfJ2Aa4AnRSbAie0jy2nqwJtgEKxsZmWRff10BG5Br1GXBKY2NRIPZaIx5u2GO206nJIq8q2mvxbdRGiiPJiX0gskVGB/lLOGo3rg+AjELyUhm6yU9R27dnoOrMqjWM3GXy3UEa4ZfLm61Cli9u46liHLfCowr1AQm2+g2qaGdHBkBriPg/HqhgUYdIhFOepdiHS30BOm/OIy7U3mcQj0+NLmlACQHLqFFgUpQnhjj2pDOX9rzLvTDLBCtUzYPdK6CakDMsBEHrVyX3P1VWpodeH5RREp6Vr/5nRR78L+5n8L1GdLAwIDAQAB",
  minimum_chrome_version: "121",
  permissions: ["tabs", "scripting", "nativeMessaging"],
  host_permissions: ["http://*/*", "https://*/*"],
  background: { service_worker: "background.js", type: "module" },
  action: { default_title: "Chrome Browser MCP" }
};
await writeFile("dist/extension/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
await cp("extension-assets", "dist/extension/assets", { recursive: true });
