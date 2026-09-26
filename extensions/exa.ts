/** Exa retrieval helpers. Keep selected evidence and its formatting intact. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXA_ENDPOINT = "https://api.exa.ai/search";
export const DEFAULT_KEEP = 4;
export const DYNAMIC_HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28";
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface ExaConfig {
	apiKey: string | undefined;
	endpoint: string;
	timeoutMs: number;
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The key sits beside the TypeSafe one, in the profile, never in the repo. */
export function loadExaConfig(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ExaConfig {
	let file: Record<string, unknown> = {};
	const dir = trimmed(env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
	try {
		const parsed = JSON.parse(readFile(join(dir, "juna.json"))) as unknown;
		if (parsed && typeof parsed === "object") file = parsed as Record<string, unknown>;
	} catch {
		// No file is a valid state: the tool then reports that it has no key.
	}
	const timeout = Number.parseInt(String(env.JUNA_EXA_TIMEOUT_MS ?? file.exaTimeoutMs ?? ""), 10);
	return {
		apiKey: trimmed(env.EXA_API_KEY) ?? trimmed(file.exaApiKey),
		endpoint: trimmed(env.JUNA_EXA_ENDPOINT) ?? trimmed(file.exaEndpoint) ?? EXA_ENDPOINT,
		timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
	};
}

export interface ExaResult {
	title: string;
	url: string;
	publishedDate?: string;
	highlights: string[];
}

export class ExaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExaError";
	}
}

export function buildSearchBody(query: string, count: number): Record<string, unknown> {
	return {
		query,
		numResults: count,
		// Allocate evidence across the requested results. Dynamic highlights cannot
		// be combined with maxCharacters or the deprecated sentence-count fields.
		contents: { highlights: { query, dynamic: true } },
	};
}

export async function search(
	query: string,
	count: number,
	config: ExaConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ExaResult[]> {
	if (!config.apiKey) {
		throw new ExaError('No Exa API key. Set EXA_API_KEY, or add "exaApiKey" to the profile\'s juna.json.');
	}

	const timeout = AbortSignal.timeout(config.timeoutMs);
	const response = await fetchImpl(config.endpoint, {
		method: "POST",
		headers: { "x-api-key": config.apiKey, "Content-Type": "application/json", "Exa-Beta": DYNAMIC_HIGHLIGHTS_BETA },
		body: JSON.stringify(buildSearchBody(query, count)),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		throw new ExaError(`Exa returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
	}

	const body = (await response.json()) as { results?: unknown };
	if (!Array.isArray(body.results)) return [];
	return body.results.map((entry) => {
		const record = entry as Record<string, unknown>;
		return {
			title: trimmed(record.title) ?? trimmed(record.url) ?? "untitled",
			url: trimmed(record.url) ?? "",
			publishedDate: trimmed(record.publishedDate),
			highlights: (Array.isArray(record.highlights) ? record.highlights : [])
				.filter((highlight): highlight is string => typeof highlight === "string" && Boolean(highlight.trim())),
		};
	});
}

/** One compact block per result: what it is, where it is, why it matched. */
export function renderResults(results: ExaResult[]): string {
	if (results.length === 0) return "No results worth keeping.";
	const blocks = results.map((result, index) => {
		const date = result.publishedDate ? ` (${result.publishedDate.slice(0, 10)})` : "";
		const lines = [`${index + 1}. ${result.title}${date}`, `   ${result.url}`];
		for (const highlight of result.highlights) lines.push(highlight);
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}

export const CONTENTS_ENDPOINT = "https://api.exa.ai/contents";
/** Upper bound requested from Exa for a single page. */
export const DEFAULT_FETCH_CHARS = 60_000;

export interface Page {
	title: string;
	url: string;
	text: string;
}

export function contentsEndpoint(config: ExaConfig): string {
	// The two endpoints differ only in their last segment, so an overridden
	// search endpoint (a proxy, a test server) carries over to fetching.
	return config.endpoint === EXA_ENDPOINT ? CONTENTS_ENDPOINT : config.endpoint.replace(/\/search$/, "/contents");
}

/** Exa reports a refused or missing page in `statuses`, not as an HTTP error. */
export function crawlFailure(statuses: unknown): string {
	const first = Array.isArray(statuses) ? (statuses[0] as Record<string, unknown> | undefined) : undefined;
	const error = first?.error as { httpStatusCode?: number; tag?: string } | undefined;
	if (!error) return "no readable text came back";
	const code = error.httpStatusCode ? ` (HTTP ${error.httpStatusCode})` : "";
	return `${error.tag ?? "could not be read"}${code}`;
}

/**
 * Fetch one page as text. Exa renders the page and strips the furniture, which
 * is the part a plain HTTP GET would leave for us to do badly. With a
 * highlights query, only the passages that answer it come back.
 */
export async function fetchPage(
	url: string,
	maxCharacters: number,
	config: ExaConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	highlightsQuery?: string,
): Promise<Page> {
	if (!config.apiKey) {
		throw new ExaError('No Exa API key. Set EXA_API_KEY, or add "exaApiKey" to the profile\'s juna.json.');
	}

	const timeout = AbortSignal.timeout(config.timeoutMs);
	// Highlights ask Exa for only the passages that answer the query, which is
	// what keeps a long page from entering the context whole.
	const contents = highlightsQuery ? { highlights: { query: highlightsQuery, dynamic: true } } : { text: { maxCharacters } };
	const response = await fetchImpl(contentsEndpoint(config), {
		method: "POST",
		headers: {
			"x-api-key": config.apiKey,
			"Content-Type": "application/json",
			...(highlightsQuery ? { "Exa-Beta": DYNAMIC_HIGHLIGHTS_BETA } : {}),
		},
		body: JSON.stringify({ urls: [url], ...contents }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		throw new ExaError(`Exa returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
	}

	const body = (await response.json()) as { results?: unknown; statuses?: unknown };
	const first = Array.isArray(body.results) ? (body.results[0] as Record<string, unknown> | undefined) : undefined;
	const highlights = Array.isArray(first?.highlights) ? (first.highlights as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
	const text = highlightsQuery ? (highlights.length ? highlights.join("\n\n") : undefined) : typeof first?.text === "string" ? first.text : undefined;
	if (!text?.trim()) throw new ExaError(`${url}: ${crawlFailure(body.statuses)}`);
	return { title: trimmed(first?.title) ?? url, url: trimmed(first?.url) ?? url, text };
}
