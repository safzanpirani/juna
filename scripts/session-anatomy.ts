#!/usr/bin/env bun
/**
 * Where does a session's context actually go? Reads a Pi session JSONL and
 * reports the token share of each message kind, so pruning effort can be aimed
 * at whatever is actually large.
 *
 *   bun scripts/session-anatomy.ts <session.jsonl>
 *   bun scripts/session-anatomy.ts --dir ~/.pi/agent/sessions --top 5
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { encode } from "gpt-tokenizer";

const tokens = (text: string) => encode(text).length;

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const record = part as { type?: string; text?: string };
				if (record.type === "text" && typeof record.text === "string") return record.text;
				return JSON.stringify(part);
			})
			.join("\n");
	}
	return content === undefined || content === null ? "" : JSON.stringify(content);
}

interface Bucket {
	tokens: number;
	count: number;
	largest: number;
}

export function anatomy(jsonl: string): { buckets: Map<string, Bucket>; total: number } {
	const buckets = new Map<string, Bucket>();
	let total = 0;

	function add(kind: string, text: string) {
		const count = tokens(text);
		const bucket = buckets.get(kind) ?? { tokens: 0, count: 0, largest: 0 };
		bucket.tokens += count;
		bucket.count += 1;
		bucket.largest = Math.max(bucket.largest, count);
		buckets.set(kind, bucket);
		total += count;
	}

	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		const role = message.role ?? "?";

		if (role === "toolResult" || message.toolName || message.toolCallId) {
			add(`tool result: ${message.toolName ?? "?"}`, textOf(message.content ?? message.output));
			continue;
		}
		if (role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [message.content];
			for (const part of parts) {
				const record = part as { type?: string };
				if (record?.type === "toolCall") add("assistant: tool call", JSON.stringify(part));
				else if (record?.type === "thinking") add("assistant: thinking", textOf(part));
				else add("assistant: text", textOf(part));
			}
			continue;
		}
		add(`${role}`, textOf(message.content));
	}

	return { buckets, total };
}

function report(path: string) {
	const { buckets, total } = anatomy(readFileSync(path, "utf8"));
	const rows = [...buckets.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
	console.log(`\n${path}`);
	console.log(`  ${total} tok across ${rows.reduce((sum, [, b]) => sum + b.count, 0)} messages`);
	for (const [kind, bucket] of rows) {
		const share = Math.round((bucket.tokens / total) * 100);
		if (share < 1 && bucket.tokens < 500) continue;
		console.log(
			`  ${kind.padEnd(26)} ${String(bucket.tokens).padStart(8)} tok ${String(share).padStart(3)}%  ` +
				`${String(bucket.count).padStart(4)} msgs, largest ${bucket.largest}`,
		);
	}
}

const dir = flag("dir");
if (dir) {
	const top = Number.parseInt(flag("top") ?? "3", 10);
	const files: { path: string; size: number }[] = [];
	const walk = (base: string) => {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			const path = join(base, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) files.push({ path, size: statSync(path).size });
		}
	};
	walk(dir.replace(/^~/, process.env.HOME ?? "~"));
	files.sort((a, b) => b.size - a.size);
	for (const file of files.slice(0, top)) report(file.path);
} else {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: session-anatomy.ts <session.jsonl> | --dir <sessions dir> [--top N]");
		process.exit(2);
	}
	report(path);
}
