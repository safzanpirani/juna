/**
 * Prune tool output down to the parts the current task needs, using Jev.
 *
 * Cache safety is the hard constraint. A tool result is edited exactly once, in
 * the `tool_result` hook, which runs before the result has ever been sent to a
 * provider. Nothing here mutates history: juna never registers a `context`
 * handler, never rewrites an earlier message, and never varies the system
 * prompt between turns. The cached prefix therefore stays byte-identical for
 * the life of the session, and pruning only changes what enters it.
 *
 * Every failure path keeps the original output. A pruner that throws must not
 * lose the user's data.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

/** Event-bus channel for pruning a result that did not arrive through `tool_result`. */
export const PRUNE_CHANNEL = "juna:prune";
export interface PruneRequest {
	event: ToolResultEvent;
	ctx: ExtensionContext;
	reply(result: Promise<ToolResultEventResult | void | undefined>): void;
}
import type { TextContent } from "@earendil-works/pi-ai";

import { assemble, excerpt, splitBounded, type Chunk } from "./chunk.ts";
import { OutputMemory, repeatMarker } from "./dedup.ts";
import { reduceBashOutput } from "./reduce.ts";
import { addSaved } from "./savings.ts";
import { failureHead, isRunner, verdictLine, verifyQuestions } from "./verify.ts";
import { spill, type SpillOptions } from "./spill.ts";
import { summarize, type SummaryOptions } from "./structure.ts";
import { uselessNotice } from "./useless.ts";
import { askJev, JevError, loadConfig, shorten, type JevConfig, type ScoreAnswer } from "./jev.ts";

/** Tools whose output is never pruned: it is short, structural, or a confirmation. */
/**
 * Pi marks a bash command that exits non-zero as an error, but its output is
 * still output: a failing test run is the main case the verdict exists for.
 * Every other tool's error stays untouched.
 */
export function prunableError(toolName: string): boolean {
	return toolName === "bash";
}

/** The status line Pi's bash tool appends to a failed command's output. */
export function exitStatus(text: string): string | undefined {
	return /(?:^|\n)(Command exited with code \d+)\s*$/.exec(text)?.[1];
}

/**
 * Run the deterministic reducers over a bash result. When Pi has already cut a
 * long output to its tail, the complete log is reduced instead, so the model
 * sees the first failures rather than only the last ones.
 */
export function reduceBash(text: string, event: Pick<ToolResultEvent, "details" | "input">, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")) {
	const command = String((event.input as { command?: unknown }).command ?? "");
	const hint = /\bjest\b/.test(command) ? 'rerun it with npx jest -t "<test name>"' : "rerun that test by name";
	const details = event.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string } | undefined;
	if (details?.truncation?.truncated && details.fullOutputPath) {
		try {
			const full = reduceBashOutput(readFile(details.fullOutputPath), hint);
			if (full.applied.includes("tests") && full.text.length <= Math.max(text.length, SPILL_SAFE_CHARS)) {
				return { text: `${full.text}\n\n[juna: reduced from the complete output at ${details.fullOutputPath}.]`, applied: full.applied };
			}
		} catch {
			// The tail Pi kept is still there to reduce.
		}
	}
	return reduceBashOutput(text, hint);
}

/** Set when the deterministic reducers changed a bash result. */
interface ReduceState {
	reduced?: { text: string; textPart: TextContent };
}

/** A reduced complete log up to this size replaces Pi's truncated tail. */
const SPILL_SAFE_CHARS = 40_000;

const NEVER_PRUNE = new Set(["edit", "write", "skill_load", "skill_search", "web_search", "web_fetch", "codemode", "tool_search", "ui_look", "ui_act", "ui_do", "code_search"]);

/** Minimum characters before pruning is worth a round trip. */
const DEFAULT_MIN_CHARS = 3_000;
const DEFAULT_MAX_CHUNKS = 40;
const DEFAULT_MIN_LINES = 8;
/** Score floor on a 0-2 scale. Below this a chunk is dropped. */
const DEFAULT_MIN_SCORE = 0.7;
/** Below this confidence the chunk is kept regardless of score. */
const DEFAULT_MIN_CONFIDENCE = 0.55;
const DEFAULT_CHUNK_LIMIT = 4_000;
/** Questions per Jev request. Shards fire in parallel. */
const DEFAULT_SHARD_SIZE = 40;
/** Ceiling on chunks for one output, and so on what pruning it can cost. */
const DEFAULT_HARD_MAX_CHUNKS = 240;
/** Score floor once the window is full, and where on the way it starts rising. */
const DEFAULT_MAX_SCORE = 1.4;
const DEFAULT_FLOOR_FROM = 50;
/** Structural folding of a whole-file read. */
const DEFAULT_UNFOLD_UNTIL = 50;
const DEFAULT_UNFOLD_LIMIT = 100;
const DEFAULT_MIN_BODY_LINES = 4;
const DEFAULT_MIN_TOTAL_LINES = 100;
const DEFAULT_MAX_PARSE_BYTES = 2_000_000;
/** The ceiling on any single result. */
const DEFAULT_SPILL_THRESHOLD = 50_000;
const DEFAULT_SPILL_HEAD = 20_000;
const DEFAULT_SPILL_TAIL = 20_000;

const RELEVANCE_LEVELS = [
	"Irrelevant. Nothing in this excerpt bears on the task: boilerplate, progress noise, unrelated files, or repetition of something already shown. Removing it costs the agent nothing.",
	"Background. The excerpt touches the same area as the task but carries no fact the agent would act on. It would only be missed if the agent had nothing else.",
	"Load-bearing. The excerpt contains a fact the agent needs to do the task: the matched code, the error, the path, the value, the failure. Removing it would force the agent to run the tool again.",
];
/** The file path a read-shaped tool call was about, when there is one. */
export function readPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName !== "read" || input.offset !== undefined || input.limit !== undefined) return undefined;
	const candidate = input.path ?? input.file ?? input.filePath;
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export interface PruneSettings extends SummaryOptions, SpillOptions {
	minChars: number;
	maxChunks: number;
	minLines: number;
	minScore: number;
	minConfidence: number;
	chunkLimit: number;
	shardSize: number;
	hardMaxChunks: number;
	/** Score floor once the context window is full. The floor rises towards this. */
	maxScore: number;
	/** Context usage, as a percentage, where the floor starts rising. */
	floorFrom: number;
}

function positive(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): PruneSettings {
	return {
		minChars: positive(env.JUNA_PRUNE_MIN_CHARS, DEFAULT_MIN_CHARS),
		maxChunks: Math.max(1, Math.floor(positive(env.JUNA_PRUNE_MAX_CHUNKS, DEFAULT_MAX_CHUNKS))),
		minLines: Math.max(1, Math.floor(positive(env.JUNA_PRUNE_MIN_LINES, DEFAULT_MIN_LINES))),
		minScore: positive(env.JUNA_PRUNE_MIN_SCORE, DEFAULT_MIN_SCORE),
		minConfidence: positive(env.JUNA_PRUNE_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE),
		chunkLimit: Math.max(1, Math.floor(positive(env.JUNA_PRUNE_CHUNK_LIMIT, DEFAULT_CHUNK_LIMIT))),
		shardSize: Math.max(1, Math.floor(positive(env.JUNA_PRUNE_SHARD_SIZE, DEFAULT_SHARD_SIZE))),
		hardMaxChunks: Math.max(1, Math.floor(positive(env.JUNA_PRUNE_HARD_MAX_CHUNKS, DEFAULT_HARD_MAX_CHUNKS))),
		maxScore: positive(env.JUNA_PRUNE_MAX_SCORE, DEFAULT_MAX_SCORE),
		floorFrom: positive(env.JUNA_PRUNE_FLOOR_FROM, DEFAULT_FLOOR_FROM),
		unfoldUntil: Math.max(1, Math.floor(positive(env.JUNA_FOLD_UNTIL, DEFAULT_UNFOLD_UNTIL))),
		unfoldLimit: Math.max(1, Math.floor(positive(env.JUNA_FOLD_LIMIT, DEFAULT_UNFOLD_LIMIT))),
		minBodyLines: Math.max(1, Math.floor(positive(env.JUNA_FOLD_MIN_BODY, DEFAULT_MIN_BODY_LINES))),
		minTotalLines: Math.max(1, Math.floor(positive(env.JUNA_FOLD_MIN_TOTAL, DEFAULT_MIN_TOTAL_LINES))),
		maxBytes: Math.max(1, Math.floor(positive(env.JUNA_FOLD_MAX_BYTES, DEFAULT_MAX_PARSE_BYTES))),
		threshold: Math.max(1, Math.floor(positive(env.JUNA_SPILL_THRESHOLD, DEFAULT_SPILL_THRESHOLD))),
		headChars: Math.max(1, Math.floor(positive(env.JUNA_SPILL_HEAD, DEFAULT_SPILL_HEAD))),
		tailChars: Math.max(1, Math.floor(positive(env.JUNA_SPILL_TAIL, DEFAULT_SPILL_TAIL))),
	};
}

/**
 * The score floor for the current turn. It sits at `minScore` while the window
 * has room and rises towards `maxScore` as it fills, so a long session prunes
 * harder than a fresh one.
 *
 * Raising the floor only affects results that have not been sent yet, so it
 * never touches the cached prefix. That is why this is a safe multi-turn lever
 * and rewriting history is not.
 */
export function floorFor(percent: number | null | undefined, settings: PruneSettings): number {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return settings.minScore;
	if (percent <= settings.floorFrom) return settings.minScore;
	const span = Math.max(1, 100 - settings.floorFrom);
	const travelled = Math.min(1, (percent - settings.floorFrom) / span);
	return settings.minScore + (settings.maxScore - settings.minScore) * travelled;
}

export function questionId(index: number): string {
	return `chunk_${index}`;
}

/**
 * One Score question per chunk. The task and the call that produced the output
 * live in the shared state; each excerpt lives in its own question, so a long
 * output never rots the state.
 */
export function buildRequest(
	task: string,
	toolName: string,
	input: string,
	chunks: Chunk[],
	config: JevConfig,
	settings: PruneSettings,
	extraQuestions?: Record<string, unknown>,
): Record<string, unknown> {
	const questions: Record<string, unknown> = { ...extraQuestions };
	for (const chunk of chunks) {
		questions[questionId(chunk.index)] = {
			type: "score",
			instructions: {
				judgement:
					"Rate how much an autonomous coding agent working on `task` needs this one excerpt of the tool output. Judge only this excerpt; the others are rated separately. When in doubt, rate it load-bearing.",
				excerpt_lines: `${chunk.startLine}-${chunk.endLine}`,
				excerpt: excerpt(chunk.text, settings.chunkLimit),
			},
			criteria: RELEVANCE_LEVELS,
		};
	}
	return {
		model: config.model,
		state: { task: task.trim(), tool: toolName, tool_input: input },
		questions,
	};
}

/**
 * Decide which chunks survive. Anything Jev did not answer, answered without a
 * usable score, or answered with low confidence is kept.
 */
export function decide(
	chunks: Chunk[],
	answers: Record<string, ScoreAnswer | undefined>,
	settings: PruneSettings,
	floor = settings.minScore,
): boolean[] {
	return chunks.map((chunk) => {
		const answer = answers[questionId(chunk.index)];
		if (!answer || typeof answer.score !== "number" || !Number.isFinite(answer.score)) return true;
		if (answer.score < 0 || answer.score > 2) return true;
		if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)
			|| answer.confidence < settings.minConfidence || answer.confidence > 1) return true;
		// A verdict on just the head and tail cannot justify deleting the unseen middle.
		if (chunk.text.length > settings.chunkLimit || chunk.text.includes("[juna spilled ")) return true;
		return answer.score >= floor;
	});
}

function describeInput(input: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${shorten(String(value), 200)}`);
		}
	}
	return parts.join(" ");
}
/** Split the questions across parallel requests, so one output never sends one huge call. */
export function shard<T>(items: T[], size: number): T[][] {
	const shards: T[][] = [];
	for (let start = 0; start < items.length; start += Math.max(1, size)) {
		shards.push(items.slice(start, start + Math.max(1, size)));
	}
	return shards;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const settings = loadSettings();
	const memory = new OutputMemory();
	/** The head of the last failure per command, so a repeat is recognisable. */
	const failures = new Map<string, string>();
	const sessionId = `${process.pid}-${randomUUID()}`;
	let spills = 0;
	let task = "";

	pi.on("session_start", () => memory.clear());
	pi.on("session_compact", () => memory.clear());
	pi.on("session_tree", () => memory.clear());
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "toolResult" || (message.isError && !prunableError(message.toolName)) || message.content.length !== 1) return;
		const part = message.content[0];
		// Only delivered bytes can be a dedup target, including in parallel tool mode.
		if (part?.type === "text" && part.text.length >= settings.minChars) memory.remember(message.toolName, part.text);
	});

	pi.on("before_agent_start", (event) => {
		// The live task is the state Jev judges every excerpt against.
		task = event.prompt.trim();
	});

	const prune: ExtensionHandler<ToolResultEvent, ToolResultEventResult> = async (event, ctx) => {
		// Per call, because parallel tool results are pruned concurrently.
		const state: ReduceState = {};
		const result = await pipeline(event, ctx, state);
		if (result !== undefined || !state.reduced) return result;
		// No later stage changed anything, but the free reducers did.
		const { text, textPart } = state.reduced;
		return { content: event.content.map((part) => (part === textPart ? ({ type: "text", text } satisfies TextContent) : part)) };
	};

	const pipeline = async (event: ToolResultEvent, ctx: ExtensionContext, state: ReduceState): Promise<ToolResultEventResult | undefined> => {
		if (NEVER_PRUNE.has(event.toolName)) return;
		// A codemode script needs the real bytes; only its own output reaches the model.
		if (event.parentToolCallId) return;
		if (event.isError && !prunableError(event.toolName)) return;

		// Explicit recovery reads must return the requested bytes unchanged.
		if (event.toolName === "read" && (event.input.offset !== undefined || event.input.limit !== undefined)) return;

		// Text parts only. Images are passed through untouched.
		const textParts = event.content.filter((part): part is TextContent => part.type === "text");
		if (textParts.length !== 1 || event.content.length !== 1) return;
		const raw = textParts[0]!.text;
		const exitLine = event.isError ? exitStatus(raw) : undefined;

		// 0. Deterministic reducers: colour codes, redraws, test-runner noise, HTML.
		let original = raw;
		if (event.toolName === "bash") {
			const cleaned = reduceBash(raw, event);
			if (cleaned.applied.length) {
				original = exitLine && !cleaned.text.trimEnd().endsWith(exitLine) ? `${cleaned.text.trimEnd()}\n\n${exitLine}` : cleaned.text;
				state.reduced = { text: original, textPart: textParts[0]! };
				addSaved(Math.max(0, raw.length - original.length));
				ctx.ui.setStatus("juna", `reduced ${cleaned.applied.join("+")}`);
			}
		}
		if (original.length < settings.minChars) return;

		const replace = (text: string) => {
			// A failed command must still say it failed, whatever was cut.
			const kept = exitLine && !text.trimEnd().endsWith(exitLine) ? `${text.trimEnd()}\n\n${exitLine}` : text;
			return {
				content: event.content.map((part) =>
					part === textParts[0] ? ({ type: "text", text: kept } satisfies TextContent) : part,
				),
			};
		};

		// The free checks run first, cheapest to most expensive. Each one that
		// fires skips everything below it, including the Jev call.

		// 1. A search that found nothing is one line, whoever asked.
		const nothing = uselessNotice(event.toolName, original);
		if (nothing) {
			addSaved(original.length - nothing.length);
			ctx.ui.setStatus("juna", `empty result collapsed`);
			return replace(nothing);
		}

		// 2. Bytes already in the conversation never need to enter it twice.
		const earlier = memory.lookup(event.toolName, original);
		if (earlier) {
			addSaved(original.length - repeatMarker(earlier).length);
			ctx.ui.setStatus("juna", `repeat dropped`);
			return replace(repeatMarker(earlier));
		}

		// 3. A whole code file read for its shape does not need every body.
		const path = readPath(event.toolName, event.input);
		if (path && !(event.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated) {
			const folded = summarize(path, original, settings);
			if (folded) {
				addSaved(original.length - folded.length);
				ctx.ui.setStatus("juna", `folded ${path.split("/").pop()}`);
				return replace(folded);
			}
		}

		// 4. Whatever is left is capped, so one result can never eat the window.
		const spilled = spill(original, event.toolName, sessionId, ++spills, settings);
		if (spilled.failed) return;
		const body = spilled.text;
		if (spilled.droppedChars > 0) {
			ctx.ui.setStatus("juna", `spilled ${Math.round(spilled.droppedChars / 1000)}k chars to a file`);

		}

		// 5. Only now is it worth asking Jev.
		if (!task || !config.apiKey) return;

		const chunks = splitBounded(body, {
			maxChunks: settings.maxChunks,
			minLines: settings.minLines,
			maxChars: settings.chunkLimit,
			hardMax: settings.hardMaxChunks,
		});
		if (chunks.length < 2) {
			if (spilled.droppedChars > 0) {
				addSaved(original.length - body.length);
				return replace(body);
			}
			return;
		}

		// A runner's verdict rides along in the batch below, so it costs no extra
		// round trip. Output small enough to arrive whole is output the model can
		// read for itself, which is why this only happens on the pruning path.
		const command = event.toolName === "bash" ? String(event.input.command ?? "") : "";
		const verify = command && isRunner(command) ? verifyQuestions(command, body, failures.get(command)) : undefined;

		const answers: Record<string, ScoreAnswer | undefined> = {};
		try {
			// Any failed shard abandons pruning; partial success cannot justify loss.
			const responses = await Promise.all(
				shard(chunks, settings.shardSize).map((group, index) =>
					askJev(
						buildRequest(
							task,
							event.toolName,
							describeInput(event.input),
							group,
							config,
							settings,
							index === 0 ? verify : undefined,
						),
						config,
						ctx.signal,
					),
				),
			);
			for (const response of responses) Object.assign(answers, response.answers ?? {});
		} catch (error) {
			// Keep the whole output. Surface the reason once, quietly.
			if (error instanceof JevError) ctx.ui.setStatus("juna", `prune off: ${shorten(error.message, 60)}`);
			return;
		}

		if (spilled.droppedChars > 0 && chunks.some((chunk) => {
			const answer = answers[questionId(chunk.index)];
			return !answer || !Number.isFinite(answer.score) || !Number.isFinite(answer.confidence)
				|| answer.confidence! < settings.minConfidence || answer.confidence! > 1
				|| answer.score! < 0 || answer.score! > 2;
		})) return;

		// A fuller window prunes harder. This only ever affects the result being
		// built now, never one already sent.
		const floor = floorFor(ctx.getContextUsage()?.percent, settings);
		const result = assemble(chunks, decide(chunks, answers, settings, floor));
		if (result.keptChunks === 0) return;
		if (result.droppedChunks === 0 || result.text.length >= body.length) {
			if (spilled.droppedChars > 0) {
				addSaved(original.length - body.length);
				return replace(body);
			}
			return;
		}

		// The verdict goes above the excerpt, because a pruned failure is exactly
		// the case where the model would otherwise have to infer one.
		const verdict = verify ? verdictLine(answers, { minConfidence: settings.minConfidence }) : undefined;
		if (verdict && command) {
			if (verdict.includes("FAILED") || verdict.includes("partly failed")) {
				const head = failureHead(body);
				if (head) failures.set(command, head);
			} else {
				failures.delete(command);
			}
		}
		const finalText = verdict ? `${verdict}\n${result.text}` : result.text;

		addSaved(original.length - finalText.length);
		ctx.ui.setStatus(
			"juna",
			`pruned ${result.droppedLines} lines`,
		);
		return replace(finalText);
	};
	pi.on("tool_result", prune);
	// A result that reaches the model outside a tool call (async-bash delivers
	// late ones as a message) asks for the same pipeline here. The reply is made
	// synchronously so the caller knows a pruner is listening.
	pi.events?.on(PRUNE_CHANNEL, (data) => {
		const request = data as PruneRequest;
		request.reply(Promise.resolve(prune(request.event, request.ctx)));
	});
}
