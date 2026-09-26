/**
 * One long-lived `cua-driver mcp` process per juna session.
 *
 * A fresh `cua-driver <tool>` process pays for daemon discovery on every call:
 * ~600 ms on Windows once its output is captured. One stdio MCP session pays
 * that once, then answers `get_config` in single-digit milliseconds. Every
 * computer-use call in juna goes through this client.
 *
 * Calls are serialized: the driver's element cache and screenshot scale are
 * per-window state, and interleaving two sequences against one window would
 * corrupt both. A process that dies mid-call is never asked again for that
 * call: input may already have been delivered, and replaying it would deliver
 * it twice. The next call starts a new process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DriverReply {
	/** `structuredContent`, when the tool returned one. */
	data?: any;
	/** The text parts, joined, without the driver's leading ✅. */
	text: string;
	isError: boolean;
	images: { data: string; mimeType: string }[];
}

export class DriverError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DriverError";
	}
}

/** Where the driver's installers put the binary, per platform. */
export function defaultBinary(platform = process.platform, env = process.env, exists = existsSync): string {
	const candidates = platform === "win32"
		? [join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")]
		: [join(homedir(), ".local", "bin", "cua-driver"), "/Applications/CuaDriver.app/Contents/MacOS/cua-driver", "/usr/local/bin/cua-driver"];
	return candidates.find((path) => exists(path)) ?? "cua-driver";
}

/**
 * The command that starts the session. `JUNA_CUA_COMMAND` replaces it whole,
 * as a JSON argv array or a plain string run through the shell, so a driver
 * elsewhere (a VM, another user's session) needs no code change.
 */
export function driverCommand(env = process.env): { file: string; args: string[]; shell: boolean } {
	const override = env.JUNA_CUA_COMMAND?.trim();
	if (override) {
		if (override.startsWith("[")) {
			const argv = JSON.parse(override) as unknown;
			if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== "string"))
				throw new DriverError("JUNA_CUA_COMMAND must be a JSON array of strings or a shell command");
			return { file: argv[0] as string, args: argv.slice(1) as string[], shell: false };
		}
		return { file: override, args: [], shell: true };
	}
	return { file: env.JUNA_CUA_BIN?.trim() || defaultBinary(), args: ["mcp"], shell: false };
}

/** Normalize one `tools/call` result. Pure. */
export function readReply(result: any): DriverReply {
	const content: any[] = Array.isArray(result?.content) ? result.content : [];
	return {
		data: result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : undefined,
		text: content.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string).join("\n").replace(/^✅\s*/, ""),
		isError: result?.isError === true,
		images: content.filter((part) => part?.type === "image" && typeof part.data === "string")
			.map((part) => ({ data: part.data as string, mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png" })),
	};
}

export class Driver {
	private child?: ChildProcessWithoutNullStreams;
	private ready?: Promise<void>;
	private buffer = "";
	private stderr = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private queue: Promise<unknown> = Promise.resolve();

	/**
	 * `setup` runs once per started process, right after the handshake. The
	 * agent cursor belongs to the session, so its settings must be applied to
	 * every new process, including one started after a crash.
	 */
	constructor(private readonly env = process.env, private readonly timeoutMs = 30_000,
		private readonly setup: [string, Record<string, unknown>][] = []) {}

	/** Serialized tool call. Throws DriverError on transport failure, never on a tool error. */
	call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<DriverReply> {
		const run = this.queue.then(() => this.send(name, args, signal));
		this.queue = run.catch(() => {});
		return run;
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.ready = undefined;
		this.fail(new DriverError("cua-driver session stopped"));
		if (child && child.exitCode === null) {
			child.stdin.end();
			setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000).unref?.();
		}
	}

	private async send(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
		signal?.throwIfAborted();
		await this.start();
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		return readReply(result);
	}

	private start(): Promise<void> {
		if (this.ready) return this.ready;
		const { file, args, shell } = driverCommand(this.env);
		const child = spawn(file, args, { shell, stdio: ["pipe", "pipe", "pipe"], env: this.env, windowsHide: true });
		this.child = child;
		this.buffer = "";
		this.stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.read(chunk));
		child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2000); });
		const died = (why: string) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.ready = undefined;
			const detail = this.stderr.trim().split("\n").slice(-3).join(" ").trim();
			this.fail(new DriverError(`cua-driver ${why}${detail ? `: ${detail}` : ""}. Its last call may or may not have run; it was not retried.`));
		};
		child.on("error", (error) => died(`could not start (${error.message}); install it from https://cua.ai/driver or set JUNA_CUA_BIN`));
		child.on("exit", (code) => died(`exited${code === null ? "" : ` with code ${code}`}`));
		this.ready = this.request("initialize", {
			protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "juna", version: "1" },
		}).then(async () => {
			this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
			// Setup is cosmetic (the visible cursor); a failure must not block real calls.
			for (const [name, args] of this.setup) await this.request("tools/call", { name, arguments: args }).catch(() => {});
		});
		this.ready.catch(() => { this.ready = undefined; });
		return this.ready;
	}

	private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new DriverError(`cua-driver did not answer ${method} within ${Math.round(this.timeoutMs / 1000)}s; the outcome is unknown`));
			}, this.timeoutMs);
			const abort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new DriverError("cancelled; the call may still complete on the desktop"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, {
				resolve: (value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); },
				reject: (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); },
			});
			try { this.write({ jsonrpc: "2.0", id, method, params }); }
			catch (error) { this.pending.get(id)?.reject(new DriverError(`cua-driver write failed: ${String(error)}`)); this.pending.delete(id); }
		});
	}

	private write(message: unknown): void {
		if (!this.child) throw new DriverError("cua-driver is not running");
		this.child.stdin.write(JSON.stringify(message) + "\n");
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.startsWith("{")) continue;
			let message: any;
			try { message = JSON.parse(line); } catch { continue; }
			const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
			if (!waiter) continue;
			this.pending.delete(message.id);
			if (message.error) waiter.reject(new DriverError(`cua-driver: ${message.error.message ?? JSON.stringify(message.error)}`));
			else waiter.resolve(message.result);
		}
	}

	private fail(error: Error): void {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
	}
}
