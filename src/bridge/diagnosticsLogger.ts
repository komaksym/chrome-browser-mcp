import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Writable } from "node:stream";

/** Controls how much operational bridge information is emitted. */
export type DiagnosticsLogLevel = "off" | "error" | "info" | "debug";

/** Represents one enabled diagnostics event level. */
export type DiagnosticsEventLevel = Exclude<DiagnosticsLogLevel, "off">;

/** Describes the bounded diagnostics state exposed through browser status. */
export interface DiagnosticsSummary {
  enabled: boolean;
  level: DiagnosticsLogLevel;
  file: string | null;
  eventCount: number;
  writeErrors: number;
  lastEvent: {
    timestamp: string;
    level: DiagnosticsEventLevel;
    event: string;
  } | null;
}

/** Provides the small logging surface shared by the bridge layers. */
export interface DiagnosticsLogger {
  /** Emits one allowlisted operational event without allowing logging to break the bridge. */
  log(level: DiagnosticsEventLevel, event: string, fields?: Record<string, unknown>): void;

  /** Returns bounded, caller-safe logger state. */
  summary(): DiagnosticsSummary;
}

/** Allows tests and the native-host entry point to configure logger sinks deterministically. */
export interface DiagnosticsLoggerOptions {
  component?: string;
  level?: DiagnosticsLogLevel;
  filePath?: string | null;
  stderr?: Pick<Writable, "write">;
  now?: () => Date;
}

type SafeFieldType = "boolean" | "number" | "string";
type SafeField = string | number | boolean;

const LEVEL_ORDER: Record<DiagnosticsLogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

const MAX_STRING_LENGTH = 120;
const SAFE_FIELD_TYPES = new Map<string, SafeFieldType>([
  ["operation", "string"],
  ["toolName", "string"],
  ["method", "string"],
  ["eventName", "string"],
  ["outcome", "string"],
  ["state", "string"],
  ["previousState", "string"],
  ["nextState", "string"],
  ["errorCode", "string"],
  ["reasonCode", "string"],
  ["recoveryStep", "string"],
  ["runId", "string"],
  ["jobId", "string"],
  ["taskId", "string"],
  ["extensionVersion", "string"],
  ["extensionId", "string"],
  ["tabStatus", "string"],
  ["durationMs", "number"],
  ["jobCount", "number"],
  ["maxConcurrency", "number"],
  ["activeWorkers", "number"],
  ["queuedJobs", "number"],
  ["transientFailures", "number"],
  ["retry", "number"],
  ["retryCount", "number"],
  ["tabId", "number"],
  ["windowId", "number"],
  ["revision", "number"],
  ["pendingCount", "number"],
  ["port", "number"],
  ["responseStatus", "number"],
  ["connected", "boolean"],
  ["ready", "boolean"],
  ["generating", "boolean"],
  ["hasAssistantText", "boolean"],
  ["hasResult", "boolean"],
  ["retryable", "boolean"],
  ["tabActive", "boolean"],
  ["tabDiscarded", "boolean"],
  ["isError", "boolean"],
  ["barrierSatisfied", "boolean"],
  ["cleaned", "boolean"],
]);

/** Converts an environment value into one supported diagnostics level. */
function parseLevel(value: string | undefined): DiagnosticsLogLevel {
  return value === "error" || value === "info" || value === "debug" ? value : "off";
}

/** Keeps a field string bounded and single-line before it reaches a log sink. */
function boundedString(value: string): string | undefined {
  const bounded = value.replace(/[\r\n\t]/g, " ").slice(0, MAX_STRING_LENGTH);
  return bounded.length > 0 ? bounded : undefined;
}

/** Keeps event names and components readable without allowing log-line injection. */
function safeName(value: string, fallback: string): string {
  const bounded = boundedString(value)?.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return bounded || fallback;
}

/** Projects arbitrary call-site fields onto the small, non-content diagnostics schema. */
function projectFields(fields: Record<string, unknown> | undefined): Record<string, SafeField> {
  const projected: Record<string, SafeField> = {};
  if (!fields) return projected;

  for (const [name, type] of SAFE_FIELD_TYPES) {
    const value = fields[name];
    if (type === "boolean" && typeof value === "boolean") projected[name] = value;
    if (type === "number" && typeof value === "number" && Number.isFinite(value)) projected[name] = value;
    if (type === "string" && typeof value === "string") {
      const safeValue = boundedString(value);
      if (safeValue) projected[name] = safeValue;
    }
  }
  return projected;
}

/** Creates a best-effort structured diagnostics logger for one local bridge process. */
export function createDiagnosticsLogger(options: DiagnosticsLoggerOptions = {}): DiagnosticsLogger {
  const level = options.level ?? parseLevel(process.env.CHROME_MCP_LOG_LEVEL);
  const filePath = options.filePath === undefined ? process.env.CHROME_MCP_LOG_FILE || null : options.filePath;
  const component = safeName(options.component ?? process.env.CHROME_MCP_INSTANCE ?? "bridge", "bridge");
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  let eventCount = 0;
  let writeErrors = 0;
  let directoryReady = false;
  let lastEvent: DiagnosticsSummary["lastEvent"] = null;

  const write = (line: string): void => {
    try {
      stderr.write(line);
    } catch {
      writeErrors += 1;
    }

    if (!filePath) return;
    try {
      if (!directoryReady) {
        mkdirSync(dirname(filePath), { recursive: true });
        directoryReady = true;
      }
      appendFileSync(filePath, line, "utf8");
    } catch {
      writeErrors += 1;
    }
  };

  return {
    log(eventLevel, event, fields) {
      if (LEVEL_ORDER[eventLevel] > LEVEL_ORDER[level]) return;
      const timestamp = now().toISOString();
      const eventName = safeName(event, "diagnostics.event");
      const record = {
        timestamp,
        level: eventLevel,
        event: eventName,
        component,
        ...projectFields(fields),
      };
      eventCount += 1;
      lastEvent = { timestamp, level: eventLevel, event: eventName };
      write(`${JSON.stringify(record)}\n`);
    },

    summary() {
      return {
        enabled: level !== "off",
        level,
        file: filePath,
        eventCount,
        writeErrors,
        lastEvent: lastEvent ? { ...lastEvent } : null,
      };
    },
  };
}
