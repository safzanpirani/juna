/**
 * Minimal TypeSafe System One (Jev) client shared by every juna extension.
 *
 * Jev answers typed questions about a state. It never writes prose, so nothing
 * here parses model output. Every caller in juna treats a failure as "keep
 * everything": a pruner that throws must not lose the user's data.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface JevConfig {
	apiKey: string | undefined;
	model: string;
	endpoint: string;
	timeoutMs: number;
}

export interface ScoreAnswer {
	score?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
}

export interface SystemOneResponse {
	answers?: Record<string, ScoreAnswer | undefined>;
	usage?: { input_tokens?: number };
}

/**
 * With JUNA_JEV_LOG set, append one JSON line per answered request: the time,
 * the question count and the billed input tokens. Jev bills input only, so
 * this file totals what juna spent on it. Logging never fails a request.
 */
export function logUsage(body: Record<string, unknown>, response: SystemOneResponse, env: NodeJS.ProcessEnv = process.env): void {
	const path = env.JUNA_JEV_LOG;
	if (!path) return;
	const questions = body.questions && typeof body.questions === "object" ? Object.keys(body.questions).length : 0;
	try {
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), questions, inputTokens: response.usage?.input_tokens ?? null })}\n`, { mode: 0o600 });
	} catch {
		// A broken log path must not cost the user a pruned result.
	}
}

export class JevError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "JevError";
		this.status = status;
	}
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** juna keeps its key beside Pi's config, or borrows the skill picker's. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = trimmed(env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
	return trimmed(env.JUNA_CONFIG) ?? join(dir, "juna.json");
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): JevConfig {
	let file: Record<string, unknown> = {};
	for (const path of [configPath(env), join(trimmed(env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent"), "skill-jev.json")]) {
		try {
			const parsed = JSON.parse(readFile(path)) as unknown;
			if (parsed && typeof parsed === "object") {
				file = { ...(parsed as Record<string, unknown>), ...file };
			}
		} catch {
			// Missing or malformed files fall through to the next source.
		}
	}

	return {
		apiKey: trimmed(env.TYPESAFE_API_KEY) ?? trimmed(file.apiKey),
		model: trimmed(env.JUNA_MODEL) ?? trimmed(file.model) ?? DEFAULT_MODEL,
		endpoint: trimmed(env.JUNA_ENDPOINT) ?? trimmed(file.endpoint) ?? SYSTEM_ONE_ENDPOINT,
		timeoutMs: positiveInteger(env.JUNA_TIMEOUT_MS ?? file.timeoutMs, DEFAULT_TIMEOUT_MS),
	};
}

export function shorten(value: string, maximum: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1).trimEnd()}…`;
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		function abort() {
			clearTimeout(timer);
			reject(new JevError("Cancelled."));
		}
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** One POST, with backoff on the documented retryable statuses. */
export async function askJev(
	body: Record<string, unknown>,
	config: JevConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	attempts = 2,
): Promise<SystemOneResponse> {
	if (!config.apiKey) {
		throw new JevError(`No TypeSafe API key. Set TYPESAFE_API_KEY, or add "apiKey" to ${configPath()}.`);
	}

	let lastError: JevError | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: composed,
			});
		} catch {
			if (signal?.aborted) throw new JevError("Cancelled.");
			// A transport failure may follow a billed submission; do not replay it.
			throw new JevError(composed.aborted ? "TypeSafe request timed out." : "TypeSafe request failed.");
		}

		if (response.ok) {
			let parsed: SystemOneResponse;
			try {
				parsed = (await response.json()) as SystemOneResponse;
			} catch {
				throw new JevError("TypeSafe returned an unreadable response.");
			}
			logUsage(body, parsed);
			return parsed;
		}

		// Never surface server bodies: an upstream can echo credentials or private input.
		await response.body?.cancel().catch(() => {});
		lastError = new JevError(`TypeSafe returned ${response.status}`, response.status);
		if (!RETRYABLE.has(response.status) || attempt === attempts) break;
		const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
		await sleep(Math.min(config.timeoutMs, Math.max(0, Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** (attempt - 1))), signal);
	}

	throw lastError ?? new JevError("TypeSafe request failed for an unknown reason.");
}
