import { type BrowserClient } from "./browserClient.js";
type AgentState = "CREATED" | "DISPATCHED" | "GENERATING" | "OBSERVATION_UNCERTAIN" | "VERIFIED_DONE" | "FAILED_TRANSIENT" | "FAILED_TERMINAL" | "CANCELLED";
/** Describes one caller-provided task assigned to a browser-backed worker. */
export interface AgentTaskInput {
    agent_id: string;
    prompt: string;
}
interface WorkerReadResult {
    ready: boolean;
    generating: boolean;
    latestUserText: string | null;
    latestUserTruncated?: boolean;
    latestAssistantText: string | null;
    latestAssistantTruncated?: boolean;
    tab?: WorkerTabState;
}
interface WorkerTabState {
    tabId: number;
    windowId: number;
    active: boolean;
    discarded: boolean;
    status: string;
}
type RecoveryStep = "current_state" | "bounded_reread" | "activate_worker_tab" | "reload_worker_tab";
interface ObservationDiagnostics {
    observation_source?: "initial_read" | "streaming_snapshot" | "backoff_reread" | "activated_reread" | "reload_reread";
    observation_state?: {
        ready: boolean;
        generating: boolean;
        hasAssistantText: boolean;
    };
    tab?: Pick<WorkerTabState, "active" | "discarded" | "status" | "windowId">;
    recovery_steps: RecoveryStep[];
    uncertainty_reason?: string;
}
declare const workerLeaseIdBrand: unique symbol;
type WorkerLeaseId = string & {
    readonly [workerLeaseIdBrand]: true;
};
interface WorkerLease {
    leaseId: WorkerLeaseId;
}
interface AgentJob {
    jobId: string;
    runId: string;
    taskId: string;
    agentId: string;
    completionMarker: string;
    submittedPrompt: string;
    submitted: boolean;
    retryRequested: boolean;
    workerLease?: WorkerLease;
    transientFailures: number;
    state: AgentState;
    tabId?: number;
    result?: AgentResult;
    error?: AgentError;
    bestObservation?: WorkerReadResult;
    diagnostics: ObservationDiagnostics;
    submittedAt?: number;
    snapshotBaselineRevision?: number;
    snapshotLastRevision?: number;
}
interface SpawnResult {
    request_id: string;
    run_id: string;
    state: "RUNNING" | "COMPLETE" | "FAILED" | "CANCELLED";
    jobs: Array<ReturnType<typeof publicJob>>;
}
/** Configures the runtime-wide limit for simultaneously active browser workers. */
export interface AgentRuntimeOptions {
    maxActiveWorkers?: number;
}
interface AgentError {
    code: string;
    message: string;
    retryable: boolean;
}
interface AgentResult {
    type: "text";
    text: string;
    contentIsUntrusted: true;
    warning: string;
    truncated: boolean;
}
export declare const DEFAULT_MAX_ACTIVE_WORKERS = 2;
/** Returns the caller-safe summary for a job without exposing its browser tab ID. */
declare function publicJob(job: AgentJob): {
    diagnostics?: ObservationDiagnostics | undefined;
    error?: AgentError | undefined;
    job_id: string;
    agent_id: string;
    task_id: string;
    state: AgentState;
    terminal: boolean;
    recoverable: boolean;
};
/** Coordinates private browser-backed jobs with bounded concurrency and verified outputs. */
export declare class AgentRuntime {
    private readonly browser;
    private readonly runs;
    private readonly spawnRequests;
    private readonly maxActiveWorkers;
    private schedulerOperation;
    /** Creates a runtime that owns worker tabs through the supplied browser bridge. */
    constructor(browser: BrowserClient, options?: AgentRuntimeOptions);
    /** Creates or replays one run for a stable request identity. */
    spawnAgents(tasks: AgentTaskInput[], maxConcurrency: number, requestId?: string): Promise<SpawnResult>;
    /** Creates a run, assigns stable job identities, and dispatches only its initial available slots. */
    private createRun;
    /** Returns whether a tab is owned by any live runtime job and must stay private from generic tools. */
    isWorkerTab(tabId: number): boolean;
    /** Advances one run atomically, returning only marker-validated worker results. */
    collectAgents(runId: string): Promise<{
        run_id: string;
        state: "CANCELLED" | "RUNNING" | "COMPLETE" | "FAILED";
        barrier: {
            satisfied: boolean;
        };
        results: {
            result: AgentResult;
            diagnostics?: ObservationDiagnostics | undefined;
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
            terminal: boolean;
            recoverable: boolean;
        }[];
        failed: {
            diagnostics?: ObservationDiagnostics | undefined;
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
            terminal: boolean;
            recoverable: boolean;
        }[];
        pending: {
            diagnostics?: ObservationDiagnostics | undefined;
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
            terminal: boolean;
            recoverable: boolean;
        }[];
    }>;
    /** Requests cancellation immediately, then serializes tab cleanup with any in-flight collection. */
    cancelAgents(runId: string): Promise<{
        run_id: string;
        cancelled: boolean;
        jobs: {
            diagnostics?: ObservationDiagnostics | undefined;
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
            terminal: boolean;
            recoverable: boolean;
        }[];
    }>;
    /** Runs an operation after all prior state transitions for the same run have settled. */
    private enqueueRunOperation;
    /** Runs one global scheduling pass after all previously queued passes have settled. */
    private enqueueSchedulerOperation;
    /** Requires an existing run ID before attempting a lifecycle operation. */
    private requireRun;
    /** Formats the public collection view from the current, serialized state of one run. */
    private collectionResult;
    /** Returns the result associated with a verified job, enforcing the runtime invariant defensively. */
    private verifiedResult;
    /** Collapses job states into the run-level state exposed by the MCP tool. */
    private runState;
    /** Reports whether a job currently owns a global active-worker lease. */
    private occupiesSlot;
    /** Marks failed jobs with no tab for one later scheduler retry without retrying them in a tight loop. */
    private retryTransientJobs;
    /** Schedules queued work across every run without exceeding the configured global ceiling. */
    private schedule;
    /** Cancels a run only after any scheduler dispatch already in flight has settled. */
    private cancelAndSchedule;
    /** Runs the scheduler while holding its serialized operation slot. */
    private pumpScheduler;
    /** Reserves all currently available global and per-run worker slots before starting browser operations. */
    private reserveAvailableJobs;
    /** Returns the number of jobs holding an active-worker lease across all runs. */
    private activeWorkerCount;
    /** Identifies jobs that the global scheduler is allowed to start or retry. */
    private isDispatchEligible;
    /** Acquires a unique capacity lease for one dispatch attempt before browser work starts. */
    private acquireWorkerLease;
    /** Captures the currently owned lease as one attempt context for async collection or retry work. */
    private currentDispatchAttempt;
    /** Returns whether this exact dispatch attempt still owns its lease and has not been cancelled. */
    private isDispatchAttemptActive;
    /** Returns whether async work still owns the exact worker lease it started under. */
    private ownsWorkerLease;
    /** Releases only the expected worker lease; duplicate or stale releases are harmless. */
    private releaseWorkerLease;
    /** Releases only the lease captured by this dispatch attempt. */
    private releaseDispatchAttempt;
    /** Opens a private worker tab when needed and submits under one exact dispatch attempt. */
    private dispatch;
    /** Records failure only for the dispatch attempt that started the asynchronous work. */
    private failJob;
    /** Cancels every unfinished job while preserving already verified or terminal outcomes. */
    private cancelRun;
    /** Marks unfinished work cancelled and releases only the lease current when cancellation starts. */
    private cancelJob;
    /** Closes a worker tab and retains ownership when cleanup fails, preventing generic tool access. */
    private closeWorkerTab;
    /** Submits a prompt with bounded retries while recognizing a lost acknowledgement idempotently. */
    private submitWithRetry;
    /** Returns whether a value has the bounded shape required of a streamed worker snapshot. */
    private isWorkerSnapshot;
    /** Returns the latest fresh snapshot from the event cache or the extension query seam. */
    private readFreshSnapshot;
    /** Records a snapshot revision only when it is newer than the post-submit observation baseline. */
    private acceptFreshSnapshot;
    /** Applies the same identity, generation, and completion-marker rules to one fresh snapshot. */
    private acceptWorkerSnapshot;
    /** Records the latest worker observation and its browser metadata for recovery diagnostics. */
    private rememberObservation;
    /** Returns true only when the browser observation proves generation has stopped with assistant output present. */
    private generationDefinitelyFinished;
    /** Validates one observation and completes the job when the exact dispatched turn and marker are present. */
    private acceptObservation;
    /** Reads the same worker turn with bounded backoff and never submits another prompt. */
    private rereadWithBackoff;
    /** Records one recovery-step failure without replacing the recovery contract's terminal error. */
    private recordRecoveryFailure;
    /** Runs one recovery step without allowing its error to escape into generic job failure handling. */
    private recoveryAttempt;
    /** Restores the previously active normal tab after activation-based worker recovery when possible. */
    private restoreActiveTab;
    /** Runs the bounded observation-only recovery ladder for a finished turn whose marker was not observed. */
    private recoverFinishedObservation;
    /** Reads and validates one worker response before exposing its bounded untrusted result. */
    private collectJob;
}
export {};
