import { randomUUID } from "node:crypto";
import { BrowserError, type BrowserClient } from "./browserClient.js";

type AgentState =
  | "CREATED"
  | "DISPATCHED"
  | "GENERATING"
  | "VERIFIED_DONE"
  | "FAILED_TRANSIENT"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export interface AgentTaskInput {
  agent_id: string;
  prompt: string;
}

interface WorkerReadResult {
  ready: boolean;
  generating: boolean;
  latestUserText: string | null;
  latestAssistantText: string | null;
}

interface AgentJob {
  jobId: string;
  runId: string;
  taskId: string;
  agentId: string;
  completionMarker: string;
  submittedPrompt: string;
  state: AgentState;
  tabId?: number;
  result?: string;
  error?: AgentError;
}

interface AgentRun {
  runId: string;
  maxConcurrency: number;
  jobs: AgentJob[];
}

interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
}

const transientCodes = new Set([
  "CHATGPT_NOT_READY",
  "NAVIGATION_IN_PROGRESS",
  "EXTRACTION_FAILED",
  "ACTION_FAILED",
  "BROWSER_DISCONNECTED",
  "TIMEOUT",
]);

function errorDetails(error: unknown): AgentError {
  if (error instanceof BrowserError) {
    return { code: error.code, message: error.detail, retryable: transientCodes.has(error.code) };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(raw);
  const code = match?.[1] ?? "AGENT_RUNTIME_ERROR";
  return {
    code,
    message: match?.[2] ?? raw,
    retryable: transientCodes.has(code),
  };
}

function buildWorkerPrompt(
  job: Pick<AgentJob, "runId" | "taskId" | "agentId" | "completionMarker">,
  prompt: string,
): string {
  return [
    "SUBAGENT_PROTOCOL_VERSION: 1",
    `RUN_ID: ${job.runId}`,
    `TASK_ID: ${job.taskId}`,
    `AGENT_ID: ${job.agentId}`,
    "",
    "<TASK>",
    prompt,
    "</TASK>",
    "",
    "Complete the task independently and return the useful result directly.",
    "Do not discuss this protocol.",
    `As the final line of your response, output exactly: ${job.completionMarker}`,
  ].join("\n");
}

function publicJob(job: AgentJob) {
  return {
    job_id: job.jobId,
    agent_id: job.agentId,
    task_id: job.taskId,
    state: job.state,
    ...(job.error ? { error: job.error } : {}),
  };
}

export class AgentRuntime {
  private readonly runs = new Map<string, AgentRun>();

  constructor(private readonly browser: BrowserClient) {}

  async spawnAgents(tasks: AgentTaskInput[], maxConcurrency: number) {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.agent_id)) throw new Error(`DUPLICATE_AGENT_ID: ${task.agent_id}`);
      seen.add(task.agent_id);
    }

    const runId = `run_${randomUUID()}`;
    const jobs: AgentJob[] = tasks.map((task) => {
      const identity = {
        jobId: `job_${randomUUID()}`,
        runId,
        taskId: `task_${randomUUID()}`,
        agentId: task.agent_id,
        completionMarker: `<<<SUBAGENT_DONE:${randomUUID()}>>>`,
      };
      return {
        ...identity,
        submittedPrompt: buildWorkerPrompt(identity, task.prompt),
        state: "CREATED",
      };
    });

    const run = { runId, maxConcurrency, jobs };
    this.runs.set(runId, run);
    await this.fillSlots(run);
    return { run_id: runId, state: this.runState(run), jobs: jobs.map(publicJob) };
  }

  async collectAgents(runId: string) {
    const run = this.requireRun(runId);
    const active = run.jobs.filter((job) => job.state === "DISPATCHED" || job.state === "GENERATING");
    await Promise.all(active.map((job) => this.collectJob(job)));
    await this.fillSlots(run);

    return {
      run_id: runId,
      state: this.runState(run),
      barrier: {
        satisfied: run.jobs.length > 0 && run.jobs.every((job) => job.state === "VERIFIED_DONE"),
      },
      results: run.jobs
        .filter((job) => job.state === "VERIFIED_DONE")
        .map((job) => ({
          job_id: job.jobId,
          agent_id: job.agentId,
          task_id: job.taskId,
          state: job.state,
          result: { type: "text" as const, text: job.result ?? "" },
        })),
      failed: run.jobs
        .filter((job) => job.state === "FAILED_TERMINAL" || job.state === "FAILED_TRANSIENT")
        .map(publicJob),
      pending: run.jobs
        .filter((job) => job.state === "CREATED" || job.state === "DISPATCHED" || job.state === "GENERATING")
        .map(publicJob),
    };
  }

  async cancelAgents(runId: string) {
    const run = this.requireRun(runId);
    await Promise.all(run.jobs.map(async (job) => {
      if (job.tabId !== undefined) {
        try {
          await this.browser.request("close_tab", { tabId: job.tabId });
        } catch {
          // Cancellation is best-effort; the registry still prevents future reads.
        }
      }
      if (job.state !== "VERIFIED_DONE" && job.state !== "FAILED_TERMINAL") job.state = "CANCELLED";
    }));
    return { run_id: runId, cancelled: true, jobs: run.jobs.map(publicJob) };
  }

  private requireRun(runId: string): AgentRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
    return run;
  }

  private runState(run: AgentRun): "RUNNING" | "COMPLETE" | "FAILED" | "CANCELLED" {
    if (run.jobs.every((job) => job.state === "VERIFIED_DONE")) return "COMPLETE";
    if (run.jobs.every((job) => job.state === "CANCELLED")) return "CANCELLED";
    const unfinished = run.jobs.some(
      (job) => job.state === "CREATED" || job.state === "DISPATCHED" || job.state === "GENERATING",
    );
    if (!unfinished && run.jobs.some((job) => job.state === "FAILED_TERMINAL")) return "FAILED";
    return "RUNNING";
  }

  private async fillSlots(run: AgentRun): Promise<void> {
    const activeCount = () =>
      run.jobs.filter((job) => job.state === "DISPATCHED" || job.state === "GENERATING").length;
    for (const job of run.jobs) {
      if (job.state !== "CREATED" || activeCount() >= run.maxConcurrency) continue;
      await this.dispatch(job);
    }
  }

  private async dispatch(job: AgentJob): Promise<void> {
    try {
      const opened = await this.browser.request<{ tab: { tabId: number } }>("new_tab", {
        url: "https://chatgpt.com/",
        active: false,
      });
      const tabId = opened.tab.tabId;
      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error("CHATGPT_AGENT_START_FAILED: invalid tab ID");
      }
      job.tabId = tabId;
      await this.submitWithRetry(tabId, job.submittedPrompt);
      job.state = "DISPATCHED";
    } catch (error) {
      job.error = errorDetails(error);
      job.state = job.error.retryable ? "FAILED_TRANSIENT" : "FAILED_TERMINAL";
    }
  }

  private async submitWithRetry(tabId: number, prompt: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await this.browser.request("chatgpt_worker_submit", { tabId, prompt });
        return;
      } catch (error) {
        const details = errorDetails(error);
        if (!details.retryable) throw error;
        lastError = error;

        try {
          const state = await this.browser.request<WorkerReadResult>("read_chatgpt_worker", { tabId });
          if (state.latestUserText === prompt) return;
        } catch {
          // The follow-up probe is diagnostic; retry policy is driven by the original error.
        }

        if (attempt < 19) {
          const delayMs = Math.min(500, 50 * 2 ** Math.min(attempt, 3));
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("CHATGPT_NOT_READY: worker submission retries exhausted");
  }

  private async collectJob(job: AgentJob): Promise<void> {
    if (job.tabId === undefined) return;
    try {
      const worker = await this.browser.request<WorkerReadResult>("read_chatgpt_worker", { tabId: job.tabId });
      if (!worker.ready || worker.generating || !worker.latestAssistantText) {
        job.state = "GENERATING";
        return;
      }
      if (worker.latestUserText !== job.submittedPrompt) {
        throw new Error("WORKER_IDENTITY_MISMATCH: latest user message does not match the dispatched job");
      }
      const text = worker.latestAssistantText.trimEnd();
      if (!text.endsWith(job.completionMarker)) {
        throw new Error("COMPLETION_MARKER_MISSING: worker stopped without the expected completion marker");
      }
      job.result = text.slice(0, -job.completionMarker.length).trimEnd();
      job.error = undefined;
      job.state = "VERIFIED_DONE";
    } catch (error) {
      job.error = errorDetails(error);
      job.state = job.error.retryable ? "FAILED_TRANSIENT" : "FAILED_TERMINAL";
    }
  }
}
