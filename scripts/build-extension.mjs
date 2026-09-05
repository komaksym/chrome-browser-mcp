import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const { instances } = JSON.parse(await readFile(new URL("./instances.json", import.meta.url), "utf8"));

for (const instance of instances) {
  await mkdir(instance.extensionDir, { recursive: true });
  await build({
    entryPoints: ["src/extension/background.ts"],
    outfile: `${instance.extensionDir}/background.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: true,
    define: { MCP_NATIVE_HOST_NAME: JSON.stringify(instance.hostName) },
  });
  const manifest = {
    manifest_version: 3,
    name: instance.label,
    version,
    description: "Local Chrome read/write access for a private ChatGPT MCP app.",
    key: instance.key,
    minimum_chrome_version: "121",
    permissions: ["tabs", "scripting", "nativeMessaging"],
    host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: instance.label }
  };
  await writeFile(`${instance.extensionDir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
}
