#!/usr/bin/env bun
/**
 * Prune a real tool output against a real task, to tune the thresholds.
 *
 *   bun scripts/prune-demo.ts --task "find the failing test" --cmd "bun test"
 *   bun scripts/prune-demo.ts --task "..." --file some-output.txt
 */

import { readFileSync } from "node:fs";

import { assemble, splitBounded } from "../extensions/chunk.ts";
import { buildRequest, decide, loadSettings, questionId, shard } from "../extensions/jev-prune.ts";
import { askJev, loadConfig } from "../extensions/jev.ts";

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const task = flag("task");
if (!task) {
	console.error("usage: prune-demo.ts --task <task> (--file <path> | --cmd <command>)");
	process.exit(2);
}

const file = flag("file");
const cmd = flag("cmd");
const output = file
	? readFileSync(file, "utf8")
	: cmd
		? new TextDecoder().decode(Bun.spawnSync(["bash", "-lc", cmd]).stdout)
		: readFileSync(0, "utf8");

const config = loadConfig();
const settings = loadSettings();
const chunks = splitBounded(output, { maxChunks: settings.maxChunks, minLines: settings.minLines, maxChars: settings.chunkLimit, hardMax: settings.hardMaxChunks });
const started = Date.now();
const answers: import("../extensions/jev.ts").SystemOneResponse["answers"] = {};
try {
	const responses = await Promise.all(shard(chunks, settings.shardSize).map((group) => askJev(
		buildRequest(task, cmd ? "bash" : "read", cmd ?? file ?? "stdin", group, config, settings), config,
	)));
	for (const response of responses) Object.assign(answers, response.answers ?? {});
} catch {
	for (const key of Object.keys(answers)) delete answers[key];
	console.error("Pruning failed; keeping original output.");
}

const kept = decide(chunks, answers, settings);
const result = assemble(chunks, kept);

for (const chunk of chunks) {
	const answer = answers[questionId(chunk.index)];
	const verdict = kept[chunk.index] ? "keep" : "DROP";
	console.error(
		`${verdict}  lines ${String(chunk.startLine).padStart(5)}-${String(chunk.endLine).padEnd(5)}  score=${answer?.score?.toFixed(2) ?? "-"}  conf=${answer?.confidence?.toFixed(2) ?? "-"}`,
	);
}
console.error(
	`\n${Date.now() - started}ms  ${output.length} -> ${result.text.length} chars (${Math.round((1 - result.text.length / output.length) * 100)}% saved), ${result.droppedLines}/${result.keptLines + result.droppedLines} lines dropped`,
);
console.log(result.keptChunks === 0 ? output : result.text);
