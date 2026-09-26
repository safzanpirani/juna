#!/usr/bin/env bun
/**
 * Summarize bench/run.ts results as markdown, priced per million tokens.
 *
 *   bun bench/report.ts /tmp/juna-bench/results.json \
 *     --input 10 --output 50 --cache-read 1 --jev 0.042
 *
 * "input" is uncached input. Jev bills input tokens only.
 */

import { readFileSync } from "node:fs";

function flag(name: string, fallback: string): number {
	const index = process.argv.indexOf(`--${name}`);
	return Number(index === -1 ? fallback : process.argv[index + 1]);
}

interface Result {
	arm: string;
	task: string;
	passed: boolean;
	seconds: number;
	requests: number;
	input: number;
	cacheRead: number;
	output: number;
	toolCalls: number;
	toolResultChars: number;
	jevInputTokens: number;
	jevRequests: number;
	name?: string;
	note?: string;
	webToolCalls?: number;
	bashNetworkCalls?: number;
	networkCommands?: string[];
}

const path = process.argv[2];
if (!path) throw new Error("usage: bench/report.ts <results.json> [--input N --output N --cache-read N --jev N]");
const price = { input: flag("input", "10"), output: flag("output", "50"), cacheRead: flag("cache-read", "1"), jev: flag("jev", "0.042") };
const results = JSON.parse(readFileSync(path, "utf8")) as Result[];

const cost = (r: Result) => (r.input * price.input + r.cacheRead * price.cacheRead + r.output * price.output + r.jevInputTokens * price.jev) / 1e6;
const sum = (rows: Result[], pick: (r: Result) => number) => rows.reduce((total, r) => total + pick(r), 0);
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : Math.round(n).toLocaleString("en-US"));
const pct = (a: number, b: number) => (a === 0 ? "n/a" : `${b <= a ? "−" : "+"}${Math.abs(Math.round(((b - a) / a) * 100))}%`);

const tasks = [...new Set(results.map((r) => r.task))];
const ARMS = ["stock", "stock-skills", "juna", "juna-lean"].filter((arm) => results.some((r) => r.arm === arm));
const LABEL: Record<string, string> = { stock: "Stock Pi, no skills", "stock-skills": "Stock Pi, skills", juna: "juna", "juna-lean": "juna-lean" };
console.log(`Prices per million tokens: input $${price.input}, cached input $${price.cacheRead}, output $${price.output}, Jev input $${price.jev}.\n`);
console.log("| Task | Arm | Passed | Requests | Uncached in | Cached in | Output | Tool output (chars) | Jev in | Cost | Time |");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const task of tasks) {
	for (const arm of ARMS) {
		const rows = results.filter((r) => r.task === task && r.arm === arm);
		if (!rows.length) continue;
		const n = rows.length;
		console.log(
			`| ${task} | ${arm} | ${rows.filter((r) => r.passed).length}/${n} | ${(sum(rows, (r) => r.requests) / n).toFixed(1)} | ${k(sum(rows, (r) => r.input) / n)} | ${k(sum(rows, (r) => r.cacheRead) / n)} | ${k(sum(rows, (r) => r.output) / n)} | ${k(sum(rows, (r) => r.toolResultChars) / n)} | ${k(sum(rows, (r) => r.jevInputTokens) / n)} | $${(sum(rows, cost) / n).toFixed(3)} | ${Math.round(sum(rows, (r) => r.seconds) / n)}s |`,
		);
	}
}
console.log("\nPer-run averages.\n");

const byArm = (arm: string) => results.filter((r) => r.arm === arm);
const baselines = ARMS.filter((arm) => arm !== "juna");
const line = (label: string, pick: (r: Result) => number, format: (n: number) => string) => {
	const juna = sum(byArm("juna"), pick);
	const cells = baselines.map((arm) => format(sum(byArm(arm), pick)));
	const changes = baselines.map((arm) => pct(sum(byArm(arm), pick), juna));
	console.log(`| ${label} | ${cells.join(" | ")} | ${format(juna)} | ${changes.join(" | ")} |`);
};
console.log(`| All runs | ${baselines.map((arm) => LABEL[arm]).join(" | ")} | juna | ${baselines.map((arm) => `juna vs ${LABEL[arm]}`).join(" | ")} |`);
console.log(`|---|${baselines.map(() => "---:|").join("")}---:|${baselines.map(() => "---:|").join("")}`);
line("Passed", (r) => (r.passed ? 1 : 0), (n) => String(n));
line("Requests", (r) => r.requests, (n) => String(n));
line("Uncached input tokens", (r) => r.input, k);
line("Cached input tokens", (r) => r.cacheRead, k);
line("Output tokens", (r) => r.output, k);
line("Tool output characters", (r) => r.toolResultChars, k);
line("Jev input tokens", (r) => r.jevInputTokens, k);
line("Total cost", cost, (n) => `$${n.toFixed(2)}`);
line("Wall time", (r) => r.seconds, (n) => `${Math.round(n)}s`);

if (results.some((r) => r.webToolCalls !== undefined)) {
	console.log("\nHow each run reached the web: juna's web tools, or network commands through bash.\n");
	console.log("| Run | Passed | web_search/web_fetch | bash network calls | First network command | Grade |");
	console.log("|---|---|---:|---:|---|---|");
	for (const r of [...results].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
		const first = (r.networkCommands ?? [])[0]?.replace(/\|/g, "\\|").slice(0, 90) ?? "";
		console.log(`| ${r.name} | ${r.passed ? "yes" : "no"} | ${r.webToolCalls ?? 0} | ${r.bashNetworkCalls ?? 0} | ${first ? `\`${first}\`` : ""} | ${(r.note ?? "").replace(/\|/g, "/")} |`);
	}
}
