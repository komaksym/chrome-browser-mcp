import { resolve } from "node:path";
import {
  LiveCodeReviewSetupError,
  LIVE_CODE_REVIEW_FAILURE,
  runLiveCodeReview,
} from "./support/live-chatgpt-code-review.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

try {
  const result = await runLiveCodeReview({ root: ROOT });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  if (error instanceof LiveCodeReviewSetupError) {
    process.stderr.write(`LIVE CHATGPT CODE REVIEW FAILED [${error.category ?? LIVE_CODE_REVIEW_FAILURE.WORKFLOW}]: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
