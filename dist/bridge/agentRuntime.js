import { randomUUID } from "node:crypto";
import { BrowserError } from "./browserClient.js";
const transientCodes = new Set([
    "CHATGPT_NOT_READY",
    "NAVIGATION_IN_PROGRESS",
    "EXTRACTION_FAILED",
    "ACTION_FAILED",
    "BROWSER_DISCONNECTED",
    "TIMEOUT",
]);
const MAX_TRANSIENT_FAILURES = 3;
function errorDetails(error) {
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
function buildWorkerPrompt(job, prompt) {
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
function publicJob(job) {
    return {
        job_id: job.jobId,
        agent_id: job.agentId,
        task_id: job.taskId,
        state: job.state,
        ...(job.error ? { error: job.error } : {}),
    };
}
export class AgentRuntime {
    browser;
    runs = new Map();
    constructor(browser) {
        this.browser = browser;
    }
    async spawnAgents(tasks, maxConcurrency) {
        const seen = new Set();
        for (const task of tasks) {
            if (seen.has(task.agent_id))
                throw new Error(`DUPLICATE_AGENT_ID: ${task.agent_id}`);
            seen.add(task.agent_id);
        }
        const runId = `run_${randomUUID()}`;
        const jobs = tasks.map((task) => {
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
                submitted: false,
                transientFailures: 0,
                state: "CREATED",
            };
        });
        const run = { runId, maxConcurrency, jobs };
        this.runs.set(runId, run);
        await this.fillSlots(run);
        return { run_id: runId, state: this.runState(run), jobs: jobs.map(publicJob) };
    }
    async collectAgents(runId) {
        const run = this.requireRun(runId);
        await this.retryTransientJobs(run);
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
                result: { type: "text", text: job.result ?? "" },
            })),
            failed: run.jobs
                .filter((job) => job.state === "FAILED_TERMINAL" || job.state === "FAILED_TRANSIENT")
                .map(publicJob),
            pending: run.jobs
                .filter((job) => job.state === "CREATED" || job.state === "DISPATCHED" || job.state === "GENERATING")
                .map(publicJob),
        };
    }
    async cancelAgents(runId) {
        const run = this.requireRun(runId);
        await Promise.all(run.jobs.map(async (job) => {
            if (job.tabId !== undefined) {
                try {
                    await this.browser.request("close_tab", { tabId: job.tabId });
                }
                catch {
                    // Cancellation is best-effort; the registry still prevents future reads.
                }
            }
            if (job.state !== "VERIFIED_DONE" && job.state !== "FAILED_TERMINAL")
                job.state = "CANCELLED";
        }));
        return { run_id: runId, cancelled: true, jobs: run.jobs.map(publicJob) };
    }
    requireRun(runId) {
        const run = this.runs.get(runId);
        if (!run)
            throw new Error(`RUN_NOT_FOUND: ${runId}`);
        return run;
    }
    runState(run) {
        if (run.jobs.every((job) => job.state === "VERIFIED_DONE"))
            return "COMPLETE";
        const allSettled = run.jobs.every((job) => job.state === "VERIFIED_DONE" || job.state === "FAILED_TERMINAL" || job.state === "CANCELLED");
        if (allSettled && run.jobs.some((job) => job.state === "CANCELLED"))
            return "CANCELLED";
        if (allSettled && run.jobs.some((job) => job.state === "FAILED_TERMINAL"))
            return "FAILED";
        return "RUNNING";
    }
    occupiesSlot(job) {
        return (job.state === "DISPATCHED" ||
            job.state === "GENERATING" ||
            (job.state === "FAILED_TRANSIENT" && job.tabId !== undefined));
    }
    async retryTransientJobs(run) {
        for (const job of run.jobs) {
            if (job.state !== "FAILED_TRANSIENT")
                continue;
            if (job.tabId !== undefined) {
                if (job.submitted)
                    await this.collectJob(job);
                else
                    await this.dispatch(job);
                continue;
            }
            if (run.jobs.filter((candidate) => this.occupiesSlot(candidate)).length >= run.maxConcurrency)
                continue;
            await this.dispatch(job);
        }
    }
    async fillSlots(run) {
        const activeCount = () => run.jobs.filter((job) => this.occupiesSlot(job)).length;
        for (const job of run.jobs) {
            if (job.state !== "CREATED" || activeCount() >= run.maxConcurrency)
                continue;
            await this.dispatch(job);
        }
    }
    async dispatch(job) {
        try {
            let tabId = job.tabId;
            if (tabId === undefined) {
                const opened = await this.browser.request("new_tab", {
                    url: "https://chatgpt.com/",
                    active: false,
                });
                tabId = opened.tab.tabId;
                if (!Number.isInteger(tabId) || tabId <= 0) {
                    throw new Error("CHATGPT_AGENT_START_FAILED: invalid tab ID");
                }
                job.tabId = tabId;
            }
            await this.submitWithRetry(tabId, job.submittedPrompt);
            job.submitted = true;
            job.error = undefined;
            job.transientFailures = 0;
            job.state = "DISPATCHED";
        }
        catch (error) {
            await this.failJob(job, error);
        }
    }
    async failJob(job, error) {
        const details = errorDetails(error);
        if (details.retryable) {
            job.transientFailures += 1;
            if (job.transientFailures < MAX_TRANSIENT_FAILURES) {
                job.error = details;
                job.state = "FAILED_TRANSIENT";
                return;
            }
            job.error = {
                ...details,
                message: `${details.message} (transient retry budget exhausted)`,
                retryable: false,
            };
        }
        else {
            job.error = details;
        }
        job.state = "FAILED_TERMINAL";
        if (job.tabId !== undefined) {
            try {
                await this.browser.request("close_tab", { tabId: job.tabId });
            }
            catch {
                // Terminal jobs never access the worker again, even if tab cleanup fails.
            }
            job.tabId = undefined;
        }
    }
    async submitWithRetry(tabId, prompt) {
        let lastError;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
                await this.browser.request("chatgpt_worker_submit", { tabId, prompt });
                return;
            }
            catch (error) {
                const details = errorDetails(error);
                if (!details.retryable)
                    throw error;
                lastError = error;
                try {
                    const state = await this.browser.request("read_chatgpt_worker", { tabId });
                    if (state.latestUserText === prompt)
                        return;
                }
                catch {
                    // The follow-up probe is diagnostic; retry policy is driven by the original error.
                }
                if (attempt < 19) {
                    const delayMs = Math.min(500, 50 * 2 ** Math.min(attempt, 3));
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error("CHATGPT_NOT_READY: worker submission retries exhausted");
    }
    async collectJob(job) {
        if (job.tabId === undefined)
            return;
        try {
            const worker = await this.browser.request("read_chatgpt_worker", { tabId: job.tabId });
            job.error = undefined;
            job.transientFailures = 0;
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
        }
        catch (error) {
            await this.failJob(job, error);
        }
    }
}
//# sourceMappingURL=agentRuntime.js.map