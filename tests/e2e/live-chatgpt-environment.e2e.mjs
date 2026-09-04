import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { LiveSmokeSetupError, startLiveChatGptEnvironment } from "./support/live-chatgpt-environment.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const bootstrap = process.argv.includes("--bootstrap");
let environment;

try {
  environment = await startLiveChatGptEnvironment({ root: ROOT });
  if (bootstrap) {
    await environment.preflightChatGpt({ bootstrap: true });
    process.stdout.write(
      "Bootstrap Chrome is open using the dedicated profile. Sign in manually, ensure skills-mcp and chrome-mcp are enabled, then return here.\n",
    );
    const readline = createInterface({ input, output });
    try {
      await readline.question("Press Enter to run the preflight. ");
    } finally {
      readline.close();
    }
  }
  await environment.preflightChatGpt();
  process.stdout.write(`${JSON.stringify({ ok: true, ...environment.report }, null, 2)}\n`);
} catch (error) {
  if (error instanceof LiveSmokeSetupError) {
    process.stderr.write(`LIVE SMOKE SETUP FAILED [${error.category}]: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await environment?.close();
}
