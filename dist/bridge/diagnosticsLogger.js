import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const LEVEL_ORDER = {
    off: 0,
    error: 1,
    info: 2,
    debug: 3,
};
const MAX_STRING_LENGTH = 120;
const SAFE_FIELD_TYPES = new Map([
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
function parseLevel(value) {
    return value === "error" || value === "info" || value === "debug" ? value : "off";
}
/** Keeps a field string bounded and single-line before it reaches a log sink. */
function boundedString(value) {
    const bounded = value.replace(/[\r\n\t]/g, " ").slice(0, MAX_STRING_LENGTH);
    return bounded.length > 0 ? bounded : undefined;
}
/** Keeps event names and components readable without allowing log-line injection. */
function safeName(value, fallback) {
    const bounded = boundedString(value)?.replace(/[^A-Za-z0-9_.:-]/g, "_");
    return bounded || fallback;
}
/** Projects arbitrary call-site fields onto the small, non-content diagnostics schema. */
function projectFields(fields) {
    const projected = {};
    if (!fields)
        return projected;
    for (const [name, type] of SAFE_FIELD_TYPES) {
        const value = fields[name];
        if (type === "boolean" && typeof value === "boolean")
            projected[name] = value;
        if (type === "number" && typeof value === "number" && Number.isFinite(value))
            projected[name] = value;
        if (type === "string" && typeof value === "string") {
            const safeValue = boundedString(value);
            if (safeValue)
                projected[name] = safeValue;
        }
    }
    return projected;
}
/** Creates a best-effort structured diagnostics logger for one local bridge process. */
export function createDiagnosticsLogger(options = {}) {
    const level = options.level ?? parseLevel(process.env.CHROME_MCP_LOG_LEVEL);
    const filePath = options.filePath === undefined ? process.env.CHROME_MCP_LOG_FILE || null : options.filePath;
    const component = safeName(options.component ?? process.env.CHROME_MCP_INSTANCE ?? "bridge", "bridge");
    const stderr = options.stderr ?? process.stderr;
    const now = options.now ?? (() => new Date());
    let eventCount = 0;
    let writeErrors = 0;
    let directoryReady = false;
    let lastEvent = null;
    const write = (line) => {
        try {
            stderr.write(line);
        }
        catch {
            writeErrors += 1;
        }
        if (!filePath)
            return;
        try {
            if (!directoryReady) {
                mkdirSync(dirname(filePath), { recursive: true });
                directoryReady = true;
            }
            appendFileSync(filePath, line, "utf8");
        }
        catch {
            writeErrors += 1;
        }
    };
    return {
        log(eventLevel, event, fields) {
            if (LEVEL_ORDER[eventLevel] > LEVEL_ORDER[level])
                return;
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
//# sourceMappingURL=diagnosticsLogger.js.map