import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./runner.py", import.meta.url));
const PREVIEW_CHARS = 12_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

export type Bridge = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
export interface CellResult { text: string; generation: number; outputPath?: string }

/** Holds bounded text in memory, spilling complete output only when needed. */
class Output {
	text = "";
	bytes = 0;
	path?: string;
	private fd?: number;
	constructor(private readonly directory = tmpdir()) {}
	append(text: string) {
		this.bytes += Buffer.byteLength(text);
		if (this.bytes > MAX_OUTPUT_BYTES) throw new Error("Python output exceeded 8 MiB; execution stopped.");
		if (this.fd === undefined && this.text.length + text.length > PREVIEW_CHARS) {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			const dir = mkdtempSync(join(this.directory, "juna-python-"));
			this.path = join(dir, "output.txt");
			this.fd = openSync(this.path, "wx", 0o600);
			writeSync(this.fd, this.text);
		}
		if (this.fd !== undefined) writeSync(this.fd, text);
		this.text = (this.text + text).slice(-PREVIEW_CHARS);
	}
	finish() {
		if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
		return this.text + (this.path ? `\n[Output tail shown. Captured output: ${this.path}]` : "");
	}
}

interface Job {
	id: number;
	child: ChildProcess;
	output: Output;
	controller: AbortController;
	bridge: Bridge;
	calls: Set<Promise<void>>;
	requests: Set<number>;
	accepting: boolean;
	resolve: (error?: string) => void;
	notice: string;
	fence: string;
	drained: Set<number>;
	done: boolean;
	error?: string;
}

export class PythonRuntime {
	private child?: ChildProcess;
	private job?: Job;
	private sequence = 0;
	private generation = 0;
	private notice = "Fresh Python state.";
	private cwd?: string;
	private stateDir?: string;
	private clearNext = false;

	constructor(private readonly executable = process.env.JUNA_PYTHON || (() => {
		const managed = join(process.env.JUNA_DIR || join(homedir(), ".pi/juna"), "python-venv/bin/python");
		return existsSync(managed) ? managed : "python3";
	})()) {}

	useSession(directory: string) {
		if (this.stateDir === directory) return;
		this.reset("session changed");
		this.stateDir = directory;
		this.clearNext = false;
		this.notice = "Python will restore this session's durable checkpoint when available.";
	}

	clear() { this.clearNext = true; }

	reset(reason = "explicit reset") {
		const child = this.child;
		this.child = undefined;
		this.cwd = undefined;
		this.notice = this.stateDir
			? `Python process stopped (${reason}). The next cell restores the last durable checkpoint; interrupted work is not replayed. External effects are not undone.`
			: `Python state cleared (${reason}). Earlier file writes and external effects are not undone.`;
		if (child) {
			// Python descendants belong to this process group on POSIX.
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { child.kill("SIGKILL"); }
		}
		if (this.job) {
			this.job.accepting = false;
			this.job.controller.abort();
			this.job.resolve(this.notice);
		}
	}

	private start(cwd: string) {
		const child = spawn(this.executable, ["-B", "-u", RUNNER, ...(this.stateDir ? [this.stateDir] : [])], {
			cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.cwd = cwd;
		this.generation++;
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (this.child === child) this.reset(`Python could not start: ${error.code ?? "spawn failed"}; configure JUNA_PYTHON`);
		});
		if (!child.stdio[3] || !child.stdin || !child.stdout || !child.stderr) {
			this.reset("Python could not start; configure JUNA_PYTHON");
			throw new Error("Python could not start; configure JUNA_PYTHON with a Python 3.10+ executable.");
		}
		let buffer = "";
		const control = child.stdio[3] as Readable;
		control.setEncoding("utf8");
		control.on("data", (chunk: string) => {
			if (this.child !== child) return;
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				if (newline > MAX_FRAME_CHARS) { this.reset("oversized Python protocol message"); return; }
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try { this.message(child, JSON.parse(line)); }
				catch { this.reset("invalid Python protocol message"); return; }
			}
			if (buffer.length > MAX_FRAME_CHARS) this.reset("oversized Python protocol message");
		});
		for (const [index, stream] of [child.stdout, child.stderr].entries()) {
			let tail = "";
			stream!.setEncoding("utf8");
			stream!.on("data", (text: string) => {
				const job = this.job;
				if (!job || job.child !== child) { tail = ""; return; }
				const marker = `\x1e${job.fence}:${index + 1}\x1f`;
				const combined = tail + text;
				const position = combined.indexOf(marker);
				if (position !== -1) {
					this.output(job, combined.slice(0, position));
					tail = "";
					job.drained.add(index + 1);
					this.complete(job);
				} else {
					// Retain only enough bytes to recognize a split fence.
					const end = Math.max(0, combined.length - marker.length + 1);
					this.output(job, combined.slice(0, end));
					tail = combined.slice(end);
				}
			});
			stream!.on("end", () => {
				if (this.job?.child === child && tail) this.output(this.job, tail);
				tail = "";
			});
		}
		child.stdin!.on("error", () => { if (this.child === child) this.reset("Python input closed"); });
		child.on("close", () => { if (this.child === child) this.reset("Python process exited"); });
		return child;
	}

	private output(job: Job, text: string) {
		try { job.output.append(text); }
		catch (error) { this.reset(error instanceof Error ? error.message : "output capture failed"); }
	}

	private complete(job: Job) {
		if (job.done && job.drained.size === 2) job.resolve(job.error);
	}

	private message(child: ChildProcess, message: Record<string, unknown>) {
		const job = this.job;
		if (!job || job.child !== child || message.cell !== job.id || !job.accepting) return;
		if (message.type === "output" && typeof message.text === "string") this.output(job, message.text);
		else if (message.type === "done") {
			job.accepting = false;
			job.done = true;
			job.error = typeof message.error === "string" ? message.error : undefined;
			this.complete(job);
		} else if (message.type === "fatal") {
			this.reset(typeof message.error === "string" ? message.error : "Python runner failed");
		} else if (message.type === "call") {
			if (typeof message.id !== "number" || job.requests.has(message.id) || typeof message.tool !== "string" || !message.args || typeof message.args !== "object" || Array.isArray(message.args)) throw new Error("Invalid call");
			const id = message.id;
			job.requests.add(id);
			// Bound fan-out without silently dropping or resubmitting operations.
			const task = (async () => {
				let reply: Record<string, unknown>;
				try {
					if (job.requests.size > 256) throw new Error("At most 256 bridge calls per cell; split the workload across cells.");
					if (job.calls.size >= 16) throw new Error("At most 16 bridge calls may run at once; use an asyncio.Semaphore.");
					const text = await job.bridge(message.tool as string, message.args as Record<string, unknown>, job.controller.signal);
					reply = { type: "result", id, ok: true, text };
				} catch (error) {
					reply = { type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				if (this.job === job && this.child === child && job.accepting && !job.controller.signal.aborted) child.stdin!.write(JSON.stringify(reply) + "\n");
			})();
			job.calls.add(task);
			void task.finally(() => job.calls.delete(task));
		} else throw new Error("Unknown protocol message");
	}

	async run(code: string, cwd: string, bridge: Bridge, signal?: AbortSignal, timeoutMs = 120_000): Promise<CellResult> {
		if (this.job) throw new Error("Python is busy; wait for the current cell to finish.");
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw new Error("Python timeout must be positive and at most 600 seconds.");
		if (signal?.aborted) throw new Error("Python cell cancelled before execution; state unchanged.");
		if (this.cwd && this.cwd !== cwd) this.reset("working directory changed");
		const child = this.child ?? this.start(cwd);
		let resolve!: Job["resolve"];
		const completion = new Promise<string | undefined>((done) => { resolve = done; });
		const job: Job = { id: ++this.sequence, child, output: new Output(this.stateDir), controller: new AbortController(), bridge, calls: new Set(), requests: new Set(), accepting: true, resolve, notice: this.notice, fence: randomUUID(), drained: new Set(), done: false };
		this.notice = "";
		this.job = job;
		const abort = () => this.reset("cell cancelled");
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => this.reset(`cell timed out after ${timeoutMs / 1000}s`), timeoutMs);
		let error: string | undefined;
		try {
			child.stdin!.write(JSON.stringify({ type: "run", id: job.id, code, fence: job.fence, reset: this.clearNext }) + "\n");
			this.clearNext = false;
			error = await completion;
		} finally {
			job.accepting = false;
			job.controller.abort();
			await Promise.allSettled([...job.calls]);
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.job = undefined;
		}
		const output = job.output.finish();
		if (!error && this.child !== child) error = this.notice || "Python state cleared during execution.";
		const text = [job.notice, output].filter(Boolean).join("\n");
		if (error) throw new Error(`${text}\n${error}\nThe cell may have completed some operations. Inspect state and effects before retrying.`.trim());
		return { text: text || "Cell completed (no output).", generation: this.generation, outputPath: job.output.path };
	}
}
