import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDiagnosticsLogger } from "../../src/bridge/diagnosticsLogger.js";

/** Captures logger output without involving the process stderr stream. */
function captureStderr(): { stream: Writable; output: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, output: () => text };
}

describe("diagnostics logger", () => {
  it("filters levels and drops sensitive or arbitrary fields", () => {
    const stderr = captureStderr();
    const logger = createDiagnosticsLogger({
      component: "chrome2",
      level: "info",
      filePath: null,
      stderr: stderr.stream,
      now: () => new Date("2026-09-05T08:00:00.000Z"),
    });

    logger.log("debug", "browser.request.started", { method: "read_tab" });
    logger.log("info", "agent.job.state", {
      runId: "run_1",
      jobId: "job_1",
      state: "GENERATING",
      durationMs: 42,
      prompt: "do not record this",
      pageText: "do not record this either",
      url: "https://private.example.test/account?token=secret",
      arbitrary: "not an approved field",
    });

    const lines = stderr.output().trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      timestamp: "2026-09-05T08:00:00.000Z",
      level: "info",
      event: "agent.job.state",
      component: "chrome2",
      runId: "run_1",
      jobId: "job_1",
      state: "GENERATING",
      durationMs: 42,
    });
    expect(JSON.stringify(event)).not.toContain("do not record");
    expect(JSON.stringify(event)).not.toContain("private.example.test");
    expect(event).not.toHaveProperty("arbitrary");
    expect(logger.summary()).toMatchObject({
      enabled: true,
      level: "info",
      file: null,
      eventCount: 1,
      writeErrors: 0,
      lastEvent: { timestamp: "2026-09-05T08:00:00.000Z", level: "info", event: "agent.job.state" },
    });
  });

  it("appends JSONL to the configured file and keeps a bounded summary", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chrome-browser-mcp-diagnostics-"));
    const filePath = join(sandbox, "logs", "chrome2.jsonl");
    const stderr = captureStderr();
    try {
      const logger = createDiagnosticsLogger({
        component: "chrome2",
        level: "error",
        filePath,
        stderr: stderr.stream,
        now: () => new Date("2026-09-05T08:01:00.000Z"),
      });

      logger.log("error", "browser.request.failed", {
        method: "read_chatgpt_worker",
        errorCode: "TIMEOUT",
        retryable: true,
        tabId: 17,
      });

      const fileLines = readFileSync(filePath, "utf8").trim().split("\n");
      expect(fileLines).toHaveLength(1);
      expect(JSON.parse(fileLines[0] ?? "{}")).toMatchObject({
        level: "error",
        event: "browser.request.failed",
        errorCode: "TIMEOUT",
        retryable: true,
        tabId: 17,
      });
      expect(logger.summary()).toMatchObject({ level: "error", file: filePath, eventCount: 1, writeErrors: 0 });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not emit when disabled and does not throw when a sink fails", () => {
    const stderr = { write: () => { throw new Error("sink unavailable"); } } as unknown as Writable;
    const logger = createDiagnosticsLogger({ level: "off", filePath: null, stderr });

    expect(() => logger.log("error", "bridge.failed", { errorCode: "BROWSER_DISCONNECTED" })).not.toThrow();
    expect(logger.summary()).toMatchObject({ enabled: false, eventCount: 0, writeErrors: 0 });
  });
});
