import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(current)) {
  throw new Error(`Package version ${current} is not a valid Chrome extension version.`);
}

let previous;
try {
  previous = JSON.parse(execFileSync("git", ["show", "HEAD^1:package.json"], { encoding: "utf8" })).version;
} catch (error) {
  throw new Error(`Could not read the previous package version: ${error instanceof Error ? error.message : String(error)}`);
}

if (current === previous) {
  throw new Error(`Version must be bumped for every patch. Current and previous versions are both ${current}.`);
}

console.log(`Version bump verified: ${previous} -> ${current}`);
