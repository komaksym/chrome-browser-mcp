import { type BrowserClient } from "./browserClient.js";
type AgentState = "CREATED" | "DISPATCHED" | "GENERATING" | "VERIFIED_DONE" | "FAILED_TRANSIENT" | "FAILED_TERMINAL" | "CANCELLED";
export interface AgentTaskInput {
    agent_id: string;
    prompt: string;
}
interface AgentError {
    code: string;
    message: string;
    retryable: boolean;
}
export declare class AgentRuntime {
    private readonly browser;
    private readonly runs;
    constructor(browser: BrowserClient);
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
            result: {
                type: "text";
                text: string;
            };
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
    private requireRun;
    private runState;
    private occupiesSlot;
    private retryTransientJobs;
    private fillSlots;
    private dispatch;
    private failJob;
    private submitWithRetry;
    private collectJob;
}
export {};
