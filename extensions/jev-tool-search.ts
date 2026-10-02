/**
 * Jev picks what Pi's `tool_search` loads.
 *
 * The built-in ranks deferred tools with BM25 and loads the top `limit`. Models
 * ask for small limits, and word overlap misses: in the MCP benchmark a search
 * for "tracker create_issue" loaded `create_label`, and one task took five
 * searches to reach the tool it needed. Every search costs a model request and
 * changes the declared tools.
 *
 * This hook leaves the built-in tool in place, so Pi's MCP client still waits
 * for its servers before a search. After the built-in has run, Jev scores every
 * searchable tool against the query and the task, and the tools it judges
 * needed replace the BM25 picks. The task is in the question, so one search
 * can load every tool the task will call. Any failure keeps the BM25 result.
 */

import type { ExtensionAPI, ToolInfo, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

import { askJev, loadConfig, shorten, type JevConfig, type ScoreAnswer } from "./jev.ts";

export const NEED_LEVELS = [
	"Not needed. The tool works on a different service, object or action than the search and the task call for.",
	"Adjacent. The tool touches the same service or objects, but the agent is unlikely to call it for this task.",
	"Needed. The agent will call this tool to do what the search asks for, or a step of the task that follows.",
];

/** A tool needs at least this score, on the 0 to 2 scale, to be loaded. */
export const MIN_SCORE = 1.2;
/** The most tools one search loads, Pi's default limit. */
export const MAX_LOAD = 8;
/** Above this many searchable tools, the built-in's ranking is kept. */
export const MAX_CANDIDATES = 240;
/** Questions per Jev request; shards run in parallel. */
export const SHARD_SIZE = 40;

export function isSearchable(tool: Pick<ToolInfo, "exposure">): boolean {
	return tool.exposure === "codemode" || tool.exposure === "deferred";
}

/** One Score question per tool; the query and task live in the shared state. */
export function buildRequests(query: string, task: string, tools: ToolInfo[], config: JevConfig): Record<string, unknown>[] {
	const requests: Record<string, unknown>[] = [];
	for (let start = 0; start < tools.length; start += SHARD_SIZE) {
		const questions: Record<string, unknown> = {};
		tools.slice(start, start + SHARD_SIZE).forEach((tool, offset) => {
			questions[`tool_${start + offset}`] = {
				type: "score",
				instructions: {
					judgement:
						"An agent working on `task` searched for tools with `query`. Rate whether it needs this one tool. Judge only this tool; other tools are rated separately.",
					server: tool.namespace?.name ?? "",
					server_description: shorten(tool.namespace?.description ?? "", 200),
					tool_name: tool.name,
					tool_description: shorten(tool.description ?? "", 600),
				},
				criteria: NEED_LEVELS,
			};
		});
		requests.push({ model: config.model, state: { query: query.trim(), task: shorten(task.trim(), 2_000) }, questions });
	}
	return requests;
}

/** The needed tools, best first; ties break on confidence. */
export function pick(tools: ToolInfo[], answers: Record<string, ScoreAnswer | undefined>): ToolInfo[] {
	return tools
		.map((tool, index) => ({ tool, answer: answers[`tool_${index}`] }))
		.filter(({ answer }) => typeof answer?.score === "number" && answer.score >= MIN_SCORE)
		.sort((a, b) => b.answer!.score! - a.answer!.score! || (b.answer!.confidence ?? 0) - (a.answer!.confidence ?? 0))
		.slice(0, MAX_LOAD)
		.map(({ tool }) => tool);
}

/** The built-in's result text, so the model sees the same shape either way. */
export function loadedText(tools: Pick<ToolInfo, "name" | "description">[]): string {
	return `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
		.map((tool) => `- ${tool.name}: ${(tool.description ?? "").trim().split(/\r?\n/)[0]}`)
		.join("\n")}`;
}

type Ask = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ answers?: Record<string, ScoreAnswer | undefined> }>;
type Tools = Pick<ExtensionAPI, "on" | "getActiveTools" | "getAllTools" | "setActiveTools">;

export default function (pi: Tools, ask?: Ask) {
	const config = loadConfig();
	const jev: Ask = ask ?? ((body, signal) => askJev(body, config, signal));
	let task = "";
	pi.on("before_agent_start", (event) => {
		task = event.prompt.trim();
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | undefined> => {
		if (event.toolName !== "tool_search" || event.parentToolCallId || event.isError) return;
		if (!ask && !config.apiKey) return;
		const query = String((event.input as { query?: unknown }).query ?? "");
		const loaded = new Set(((event.details as { loaded?: unknown } | undefined)?.loaded as string[] | undefined) ?? []);
		const before = pi.getActiveTools().filter((name) => !loaded.has(name));
		const candidates = pi.getAllTools().filter((tool) => isSearchable(tool) && !before.includes(tool.name));
		if (!candidates.length || candidates.length > MAX_CANDIDATES) return;
		try {
			const replies = await Promise.all(buildRequests(query, task, candidates, config).map((body) => jev(body, ctx.signal)));
			const chosen = pick(candidates, Object.assign({}, ...replies.map((reply) => reply.answers ?? {})));
			// Nothing judged needed: the built-in's matches are the better guess.
			if (!chosen.length) return;
			pi.setActiveTools([...before, ...chosen.map((tool) => tool.name)]);
			ctx.ui.setStatus("juna-tools", `jev loaded ${chosen.length} tool${chosen.length === 1 ? "" : "s"}`);
			return { content: [{ type: "text", text: loadedText(chosen) }], details: { loaded: chosen.map((tool) => tool.name), bm25: [...loaded] } };
		} catch {
			return;
		}
	});
}
