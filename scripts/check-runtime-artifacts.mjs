import { execFileSync } from "node:child_process";

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "dist"], {
  encoding: "utf8",
}).trim();

if (status) {
  console.error("Committed runtime artifacts are stale. Run npm run build and commit dist/.\n");
  console.error(status);
  process.exit(1);
}

console.log("Committed runtime artifacts match the source build.");
