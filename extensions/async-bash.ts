/**
 * Asynchronous bash, after Unreal Agent's harness.
 *
 * A bash call that finishes inside a short grace window returns exactly as
 * Pi's built-in tool would. A slower call returns a placeholder and keeps
 * running; its real result is delivered later as one `<bash_result>` message,
 * and results that land together travel together. The model never polls.
 *
 * When the model ends a turn with no tool calls while calls are running, the
 * `turn_end` handler holds the run open until a result lands, the user types,
 * the user aborts, or a heartbeat fires. Pi awaits `turn_end` handlers and
 * reads the steering queue right after, so a result queued there continues the
 * same run. That keeps `pi -p` working too: the run never ends with work
 * still in flight.
 *
 * Cache safety matches the rest of juna. The placeholder is a normal tool
 * result, edited by nobody. A late result is appended as a new message; the
 * placeholder is never rewritten. Unreal Agent sends a second tool result
 * for the same call id instead, which some providers reject, so juna does not.
 *
 * Late output passes through jev-prune over the event bus when it is loaded,
 * and fails open to the raw text when it is not.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { PRUNE_CHANNEL, type PruneRequest } from "./jev-prune.ts";

export const MESSAGE_TYPE = "juna-async";
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 600_000;
/** How often a held turn checks whether the user has typed. */
const INPUT_POLL_MS = 250;
const PRUNE_TIMEOUT_MS = 60_000;

export const PLACEHOLDER =
	"Still running in the background. Its result arrives in a later turn as a <bash_result> message: continue with independent work, or end your turn to wait for it.";

export function asyncInstructions(graceSeconds: number, heartbeatSeconds: number): string {
	return `
<juna_async>
bash calls run in the background. A call that finishes within ${graceSeconds} seconds returns normally. A slower call returns a placeholder at once and keeps running; its result arrives later as a <bash_result> message, and results that finish together arrive together.
Never sleep, poll, or tail a log to wait for a call. Issue long builds, tests and installs early, then continue with independent work, or end your turn with no tool calls to sleep until the next result arrives. If calls stay running for ${Math.round(heartbeatSeconds / 60)} minutes with nothing new, a heartbeat wakes you to check on them.
Ending a turn with nothing running ends the task, so do that only when the task is complete.
</juna_async>`;
}

interface Job {
	callId: string;
	command: string;
	startedAt: number;
	abort: AbortController;
}

interface Finished {
	job: Job;
	text: string;
	failed: boolean;
	finishedAt: number;
}

function positive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

export function formatResults(items: readonly Finished[]): string {
	return items
		.map(({ job, text, failed, finishedAt }) => {
			const head = `<bash_result tool_call_id="${job.callId}" status="${failed ? "failed" : "ok"}" elapsed="${seconds(finishedAt - job.startedAt)}">`;
			const command = job.command.length > 200 ? `${job.command.slice(0, 200)}…` : job.command;
			return `${head}\n$ ${command}\n${text || "(no output)"}\n</bash_result>`;
		})
		.join("\n\n");
}

export function formatHeartbeat(waitedMs: number, running: readonly Job[], now = Date.now()): string {
	const list = running.map((job) => `- ${job.callId} (${seconds(now - job.startedAt)}): ${job.command.slice(0, 120)}`);
	return `Heartbeat: waited ${seconds(waitedMs)} with no new results. Still running:\n${list.join("\n")}\nCheck that all is well, or end your turn to keep waiting.`;
}

export default function (pi: ExtensionAPI) {
	const graceMs = positive(process.env.JUNA_ASYNC_GRACE_MS, DEFAULT_GRACE_MS);
	const heartbeatMs = positive(process.env.JUNA_ASYNC_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
	const instructions = asyncInstructions(Math.round(graceMs / 1000), Math.round(heartbeatMs / 1000));

	const running = new Map<string, Job>();
	/** Results pruned and ready, waiting for the next safe delivery point. */
	let ready: Finished[] = [];
	/** Results still passing through the pruner. A held turn waits for them too. */
	let pruning = 0;
	let wake: (() => void) | undefined;
	let holding = false;
	/** Set by an abort, cleared by the next user prompt. No auto-wake meanwhile. */
	let aborted = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;

	const status = (ctx: ExtensionContext | undefined) => {
		ctx?.ui.setStatus("juna-async", running.size ? `⧗ ${running.size} bash running` : undefined);
	};

	const prune = async (job: Job, text: string, failed: boolean, ctx: ExtensionContext): Promise<string> => {
		if (failed) return text;
		let pending: Promise<ToolResultEventResult | void | undefined> | undefined;
		const event = {
			type: "tool_result",
			toolName: "bash",
			toolCallId: job.callId,
			input: { command: job.command },
			content: [{ type: "text", text }],
			isError: false,
			details: undefined,
		} as ToolResultEvent;
		pi.events?.emit(PRUNE_CHANNEL, { event, ctx, reply: (result) => { pending = result; } } satisfies PruneRequest);
		if (!pending) return text;
		try {
			// AbortSignal.timeout does not keep the process alive.
			const timeout = new Promise<undefined>((resolve) => {
				AbortSignal.timeout(PRUNE_TIMEOUT_MS).addEventListener("abort", () => resolve(undefined));
			});
			const result = await Promise.race([pending, timeout]);
			const part = result?.content?.[0];
			return part?.type === "text" ? part.text : text;
		} catch {
			return text;
		}
	};

	const take = (): Finished[] => {
		const items = ready;
		ready = [];
		return items;
	};

	/** Deliver while idle: a new turn, or a context note after an abort. */
	const deliverIdle = () => {
		idleTimer = undefined;
		if (!ready.length || holding) return;
		const ctx = lastCtx;
		if (ctx && !ctx.isIdle()) {
			// Between the last turn_end and agent_end. Try again shortly.
			idleTimer = setTimeout(deliverIdle, 200);
			return;
		}
		const items = take();
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: formatResults(items), display: true, details: { calls: items.map((i) => i.job.callId) } },
			aborted ? { deliverAs: "nextTurn" } : { triggerTurn: true },
		);
	};

	const finish = async (job: Job, text: string, failed: boolean, ctx: ExtensionContext) => {
		const finishedAt = Date.now();
		running.delete(job.callId);
		status(ctx);
		pruning++;
		try {
			text = await prune(job, text, failed, ctx);
		} finally {
			pruning--;
		}
		ready.push({ job, text, failed, finishedAt });
		if (wake) wake();
		else if (lastCtx?.isIdle() && !idleTimer) idleTimer = setTimeout(deliverIdle, 50);
		// While streaming, the next turn_end flushes it.
	};

	const steer = (content: string, calls: string[]) => {
		pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, details: { calls } }, { deliverAs: "steer" });
	};

	const flush = () => {
		const items = take();
		if (items.length) steer(formatResults(items), items.map((i) => i.job.callId));
	};

	/** Hold a turn that ended with calls in flight until something happens. */
	const hold = async (ctx: ExtensionContext) => {
		holding = true;
		const started = Date.now();
		try {
			while ((running.size || pruning) && !ready.length) {
				if (ctx.signal?.aborted) { aborted = true; return; }
				if (ctx.hasPendingMessages()) return;
				if (heartbeatMs > 0 && Date.now() - started >= heartbeatMs) {
					steer(formatHeartbeat(Date.now() - started, [...running.values()]), []);
					return;
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, INPUT_POLL_MS);
					wake = () => { clearTimeout(timer); resolve(); };
				});
				wake = undefined;
			}
			flush();
		} finally {
			wake = undefined;
			holding = false;
		}
	};

	pi.on("before_agent_start", (event) => {
		aborted = false;
		if (event.systemPrompt.includes("<juna_async>")) return;
		return { systemPrompt: event.systemPrompt + "\n" + instructions };
	});

	pi.on("turn_end", async (event, ctx) => {
		lastCtx = ctx;
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			if (message.stopReason === "aborted") aborted = true;
			return;
		}
		const calledTools = message.content.some((part) => part.type === "toolCall");
		if (calledTools || !(running.size || pruning)) {
			flush();
			return;
		}
		await hold(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		if (ready.length && !idleTimer) idleTimer = setTimeout(deliverIdle, 50);
	});

	pi.on("session_shutdown", () => {
		for (const job of running.values()) job.abort.abort();
		running.clear();
		ready = [];
		if (idleTimer) clearTimeout(idleTimer);
	});

	pi.registerCommand("jobs", {
		description: "List background bash calls; `/jobs kill` stops them all",
		async handler(args, ctx) {
			const now = Date.now();
			if (args.trim() === "kill") {
				for (const job of running.values()) job.abort.abort();
				ctx.ui.notify(`Stopping ${running.size} background call(s).`, "info");
				return;
			}
			if (!running.size) { ctx.ui.notify("No background bash calls.", "info"); return; }
			ctx.ui.notify([...running.values()].map((job) => `${seconds(now - job.startedAt)}  ${job.command.slice(0, 100)}`).join("\n"), "info");
		},
	});

	const template = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...template,
		async execute(callId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const builtin = createBashToolDefinition(ctx.cwd);
			// Pi ids a codemode script's calls `<parent id>/<n>`. A script awaits its result, so never detach.
			if (callId.includes("/")) return builtin.execute(callId, params, signal, onUpdate, ctx);
			const job: Job = { callId, command: String(params.command ?? ""), startedAt: Date.now(), abort: new AbortController() };
			const forward = () => job.abort.abort();
			if (signal?.aborted) forward();
			signal?.addEventListener("abort", forward, { once: true });
			let update = onUpdate;
			const run = builtin.execute(callId, params, job.abort.signal, (partial) => update?.(partial), ctx);

			let timer: ReturnType<typeof setTimeout> | undefined;
			const graceOver = new Promise<"grace">((resolve) => { timer = setTimeout(() => resolve("grace"), graceMs); });
			const outcome = await Promise.race([run.then(() => "done" as const, () => "done" as const), graceOver]);
			clearTimeout(timer);
			if (outcome === "done") {
				signal?.removeEventListener("abort", forward);
				return run; // Identical to the built-in, including its errors.
			}

			// Detach: the call outlives this turn. Esc no longer stops it; /jobs kill does.
			signal?.removeEventListener("abort", forward);
			update = undefined;
			running.set(callId, job);
			status(ctx);
			run.then(
				(result) => finish(job, textOf(result), result.isError === true, ctx),
				(error: unknown) => finish(job, error instanceof Error ? error.message : String(error), true, ctx),
			);
			return { content: [{ type: "text", text: PLACEHOLDER }], details: undefined };
		},
	});
}
