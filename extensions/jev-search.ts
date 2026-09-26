/** Web retrieval favors enough evidence in the first response. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { assemble, splitBounded, type Chunk } from "./chunk.ts";
import { askJev, JevError, loadConfig, shorten, type ScoreAnswer } from "./jev.ts";
import { buildRequest as buildPruneRequest, decide, loadSettings, shard, type PruneSettings } from "./jev-prune.ts";
import {
	DEFAULT_FETCH_CHARS,
	DEFAULT_KEEP,
	ExaError,
	fetchPage,
	loadExaConfig,
	renderResults,
	search,
} from "./exa.ts";

/** Keep code fences even when they cross chunk boundaries or are unclosed. */
export function preserveCode(chunks: Chunk[], kept: boolean[]): boolean[] {
	let fence: string | undefined;
	return chunks.map((chunk) => {
		let protectedCode = Boolean(fence);
		for (const line of chunk.text.split("\n")) {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (marker) {
				protectedCode = true;
				if (!fence) fence = marker[1];
				else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
			}
			if (/^( {4,}|\t)[ \t]*\S/.test(line)) protectedCode = true;
		}
		return protectedCode || kept[chunk.index] !== false;
	});
}

export function fetchSettings(settings: PruneSettings): PruneSettings {
	return { ...settings, minScore: Math.min(settings.minScore, 0.2), minConfidence: Math.max(settings.minConfidence, 0.9) };
}

const FETCH_TASK = "Preserve substantive page content needed to answer the complete question in one response, including definitions, constraints, exceptions, schemas and complete examples. Only obvious navigation, advertising or unrelated boilerplate may score 0. Background and uncertain passages must score at least 1. Never assume another excerpt contains a duplicate: each question is independent.";

export default function (pi: Pick<ExtensionAPI, "registerTool">) {
	const jev = loadConfig();
	const exa = loadExaConfig();
	const settings = loadSettings();

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web through Exa with dynamic highlights across results. State the complete information need, including required fields, constraints and examples, so the first response can support the task.",
		promptSnippet: "Search the web",
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "Complete information need: topic, required facts, constraints, examples and edge cases." }),
			count: Type.Optional(
				Type.Number({ minimum: 1, maximum: 10, description: `How many results to retrieve. Default ${DEFAULT_KEEP}.` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const count = Math.min(10, Math.max(1, Math.floor(params.count ?? DEFAULT_KEEP)));
			const results = await search(params.query, count, exa, signal);
			const text = results.length ? renderResults(results) : `No results for ${JSON.stringify(params.query)}.`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Read a web page as text (up to 60,000 characters). Omit question for implementation, schemas or complete examples. An optional complete question enables conservative removal of obvious boilerplate; uncertain passages and code are retained.",
		promptSnippet: "Read a web page",
		parameters: Type.Object({
			url: Type.String({ minLength: 4, description: "The page to read." }),
			question: Type.Optional(
				Type.String({ description: "Complete information need, including constraints and edge cases. Omit when the complete page is needed." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let page;
			try {
				page = await fetchPage(params.url, DEFAULT_FETCH_CHARS, exa, signal);
			} catch (error) {
				throw new Error(error instanceof ExaError ? error.message : `Exa fetch failed: ${String(error)}`);
			}

			const header = `${page.title}\n${page.url}\n\n`;
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

			// A page short enough to read whole is not worth a round trip, and
			// without a question there is nothing to judge relevance against.
			const question = (params.question ?? "").trim();
			if (!jev.apiKey || !question || page.text.length < settings.minChars) return reply(header + page.text);

			const chunks = splitBounded(page.text, {
				maxChunks: settings.maxChunks,
				minLines: settings.minLines,
				maxChars: settings.chunkLimit,
				hardMax: settings.hardMaxChunks,
			});
			if (chunks.length < 2) return reply(header + page.text);

			const conservative = fetchSettings(settings);
			const answers: Record<string, ScoreAnswer | undefined> = {};
			try {
				const responses = await Promise.all(
					shard(chunks, settings.shardSize).map((group) =>
						askJev(buildPruneRequest(`${FETCH_TASK}\n\nQuestion: ${question}`, "web_fetch", page.url, group, jev, conservative), jev, signal),
					),
				);
				for (const response of responses) Object.assign(answers, response.answers ?? {});
			} catch (error) {
				// The page is already here; hand it over whole rather than lose it.
				if (error instanceof JevError) ctx.ui.setStatus("juna", `fetch unpruned: ${shorten(error.message, 50)}`);
				return reply(header + page.text);
			}

			const kept = decide(chunks, answers, conservative);
			if (!kept.some(Boolean)) return reply(header + page.text);
			const result = assemble(chunks, preserveCode(chunks, kept));
			if (result.keptChunks === 0 || result.droppedChunks === 0) return reply(header + page.text);
			return reply(header + result.text);
		},
	});
}
