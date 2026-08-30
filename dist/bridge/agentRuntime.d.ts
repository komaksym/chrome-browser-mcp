import { type BrowserClient } from "./browserClient.js";
type AgentState = "CREATED" | "DISPATCHED" | "GENERATING" | "VERIFIED_DONE" | "FAILED_TRANSIENT" | "FAILED_TERMINAL" | "CANCELLED";
/** Describes one caller-provided task assigned to a browser-backed worker. */
export interface AgentTaskInput {
    agent_id: string;
    prompt: string;
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
/** Coordinates private browser-backed jobs with bounded concurrency and verified outputs. */
export declare class AgentRuntime {
    private readonly browser;
    private readonly runs;
    /** Creates a runtime that owns worker tabs through the supplied browser bridge. */
    constructor(browser: BrowserClient);
    /** Creates a run, assigns stable job identities, and dispatches only its initial available slots. */
    spawnAgents(tasks: AgentTaskInput[], maxConcurrency: number): Promise<{
        run_id: string;
        state: "CANCELLED" | "RUNNING" | "COMPLETE" | "FAILED";
        jobs: {
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
        }[];
    }>;
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
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
            result: AgentResult;
        }[];
        failed: {
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
        }[];
        pending: {
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
        }[];
    }>;
    /** Requests cancellation immediately, then serializes tab cleanup with any in-flight collection. */
    cancelAgents(runId: string): Promise<{
        run_id: string;
        cancelled: boolean;
        jobs: {
            error?: AgentError | undefined;
            job_id: string;
            agent_id: string;
            task_id: string;
            state: AgentState;
        }[];
    }>;
    /** Runs an operation after all prior state transitions for the same run have settled. */
    private enqueueRunOperation;
    /** Requires an existing run ID before attempting a lifecycle operation. */
    private requireRun;
    /** Formats the public collection view from the current, serialized state of one run. */
    private collectionResult;
    /** Returns the result associated with a verified job, enforcing the runtime invariant defensively. */
    private verifiedResult;
    /** Collapses job states into the run-level state exposed by the MCP tool. */
    private runState;
    /** Reports whether a job currently consumes one of its run's browser worker slots. */
    private occupiesSlot;
    /** Retries failed transient work without exceeding the run-wide concurrency ceiling. */
    private retryTransientJobs;
    /** Dispatches queued jobs until the run has filled all currently available worker slots. */
    private fillSlots;
    /** Opens a private worker tab when needed and submits the job's protocol-bound prompt. */
    private dispatch;
    /** Records a failure or closes the job permanently after its transient retry budget is exhausted. */
    private failJob;
    /** Cancels every unfinished job while preserving already verified or terminal outcomes. */
    private cancelRun;
    /** Marks unfinished work cancelled and best-effort closes any tab still owned by the run. */
    private cancelJob;
    /** Closes a worker tab and retains ownership when cleanup fails, preventing generic tool access. */
    private closeWorkerTab;
    /** Submits a prompt with bounded retries while recognizing a lost acknowledgement idempotently. */
    private submitWithRetry;
    /** Reads and validates one worker response before exposing its bounded untrusted result. */
    private collectJob;
}
export {};
