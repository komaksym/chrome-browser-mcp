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
/** Creates a best-effort structured diagnostics logger for one local bridge process. */
export declare function createDiagnosticsLogger(options?: DiagnosticsLoggerOptions): DiagnosticsLogger;
