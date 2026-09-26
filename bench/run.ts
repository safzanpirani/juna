#!/usr/bin/env bun
/**
 * Run the same tasks through stock Pi and through juna, with the same model,
 * and record what each run cost and whether it passed.
 *
 *   bun bench/run.ts --fixture /tmp/commander --out /tmp/juna-bench \
 *     --model <provider>/<id> --thinking medium --repeats 3
 *
 * Three arms, chosen with --arms (default: all three):
 * - stock:        a throwaway profile with default settings and --no-skills, the
 *                 smallest stock prompt there is.
 * - stock-skills: the same profile with skill discovery on, so the prompt lists
 *                 every skill installed on this machine, as stock Pi does.
 * - juna:         a freshly seeded profile, exactly as `juna` would build it.
 * - juna-lean:    juna without the web tools, with bench/variants/lean.md added
 *                 to its AGENTS.md: narrow bash for web data, skills only on need.
 *
 * Every run gets its own copy of the fixture, its own session directory and its
 * own Jev usage log. The copy has no .git, so a task's setup cannot be read back
 * with `git diff`. Grading is done by code after the agent exits.
 */

import { existsSync, mkdirSync, statfsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { snapshot } from "./snapshot.ts";
import { TASKS, type Task } from "./tasks.ts";
import { WEB_TASKS } from "./web-tasks.ts";

const repo = resolve(import.meta.dir, "..");

function flag(name: string, fallback?: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? fallback : process.argv[index + 1];
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

const fixture = resolve(flag("fixture"));
const out = resolve(flag("out"));
const model = flag("model");
const thinking = flag("thinking", "medium");
const repeats = Number(flag("repeats", "2"));
const concurrency = Number(flag("concurrency", "4"));
const timeoutMs = Number(flag("timeout-min", "15")) * 60_000;
const suite = flag("suite", "code");
const SUITE = suite === "web" ? WEB_TASKS : TASKS;
const onlyTasks = flag("tasks", SUITE.map((task) => task.id).join(",")).split(",");
const arms = flag("arms", "stock,stock-skills,juna").split(",") as Arm[];
const mainDir = process.env.PI_MAIN_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const junaKeys = join(process.env.JUNA_DIR ?? join(homedir(), ".pi", "juna"), "juna.json");

type Arm = "stock" | "stock-skills" | "juna" | "juna-lean";

interface Job {
	arm: Arm;
	task: Task;
	repeat: number;
}

function sh(cwd: string) {
	return (command: string) => {
		const result = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
		return { code: result.exitCode, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
	};
}

/** A Pi profile with nothing in it but credentials and the model catalogue. */
function stockProfile(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), "{}\n");
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		if (existsSync(join(mainDir, file))) symlinkSync(join(mainDir, file), join(dir, file));
	}
	return dir;
}

/** A juna profile the launcher will seed on first run, plus the key file. */
function junaProfile(dir: string): string {
	mkdirSync(dir, { recursive: true });
	if (existsSync(junaKeys)) symlinkSync(junaKeys, join(dir, "juna.json"));
	return dir;
}

/** Below this much free disk a new run waits, so parallel runs cannot fill the disk. */
const MIN_FREE_BYTES = Number(flag("min-free-gb", "3")) * 1024 ** 3;

async function waitForDisk(name: string): Promise<void> {
	let warned = false;
	for (;;) {
		const fs = statfsSync(tmpdir());
		if (fs.bavail * fs.bsize >= MIN_FREE_BYTES) return;
		if (!warned) console.error(`${name}: waiting for free disk (${(fs.bavail * fs.bsize / 1024 ** 3).toFixed(1)} GB free)`);
		warned = true;
		await Bun.sleep(5000);
	}
}

/** juna's profile with the lean variant appended to its AGENTS.md. The launcher keeps an existing AGENTS.md. */
function leanProfile(dir: string): string {
	junaProfile(dir);
	const base = readFileSync(join(repo, "config", "AGENTS.md"), "utf8").trimEnd();
	writeFileSync(join(dir, "AGENTS.md"), `${base}\n${readFileSync(join(repo, "bench", "variants", "lean.md"), "utf8")}`);
	return dir;
}

async function runOne(job: Job): Promise<Record<string, unknown>> {
	const name = `${job.task.id}-${job.arm}-${job.repeat}`;
	await waitForDisk(name);
	const runDir = join(out, "runs", name);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	const work = join(mkdtempSync(join(tmpdir(), "juna-bench-")), "repo");
	const copy = Bun.spawnSync(["cp", "-cR", fixture, work]);
	if (copy.exitCode !== 0) Bun.spawnSync(["cp", "-R", fixture, work]);
	const shell = sh(work);
	job.task.setup?.(work);
	const start = snapshot(work, shell);

	const sessionDir = join(runDir, "session");
	const jevLog = join(runDir, "jev.jsonl");
	const common = ["--model", model, "--thinking", thinking, "--session-dir", sessionDir, "-p", job.task.prompt];
	const [command, args, env]: [string, string[], Record<string, string>] =
		job.arm === "juna"
			? [join(repo, "bin", "juna"), common, { JUNA_DIR: junaProfile(join(runDir, "profile")), JUNA_JEV_LOG: jevLog }]
			: job.arm === "juna-lean"
			? [join(repo, "bin", "juna"), ["--exclude-tools", "web_search,web_fetch", ...common], { JUNA_DIR: leanProfile(join(runDir, "profile")), JUNA_JEV_LOG: jevLog }]
			: ["pi", job.arm === "stock" ? ["--no-skills", ...common] : common, { PI_CODING_AGENT_DIR: stockProfile(join(runDir, "profile")) }];

	const started = Date.now();
	const child = Bun.spawn([command, ...args], {
		cwd: work,
		env: { ...process.env, ...env, CI: "1" },
		stdout: Bun.file(join(runDir, "stdout.log")),
		stderr: Bun.file(join(runDir, "stderr.log")),
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const exitCode = await child.exited;
	clearTimeout(timer);
	const seconds = (Date.now() - started) / 1000;

	const grade = job.task.gradeAsync ? await job.task.gradeAsync(work) : job.task.grade!(work, shell, start.changed);
	writeFileSync(join(runDir, "diff.patch"), start.diff());
	const record = { name, arm: job.arm, task: job.task.id, repeat: job.repeat, model, thinking, exitCode, timedOut: seconds * 1000 >= timeoutMs, seconds, ...grade, ...usage(sessionDir), ...jev(jevLog) };
	writeFileSync(join(runDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
	rmSync(join(work, ".."), { recursive: true, force: true });
	console.log(`${name}: ${grade.passed ? "PASS" : "FAIL"} ${seconds.toFixed(0)}s ${grade.note}`);
	return record;
}

/** A bash command that reaches the network: how stock Pi works around having no web tool. */
const NETWORK = /\b(curl|wget|npm (view|info|show)|gh (api|release|repo|search)|lynx|w3m|http(ie)?\b|urllib|requests\.get|fetch\()|https?:\/\//;

/** Provider-reported usage, summed over every assistant message in the session. */
function usage(sessionDir: string) {
	const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, toolCalls: 0, toolResultChars: 0, junaMarkers: 0, webToolCalls: 0, bashNetworkCalls: 0, networkCommands: [] as string[] };
	if (!existsSync(sessionDir)) return totals;
	for (const file of readdirSync(sessionDir).filter((entry) => entry.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(sessionDir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { message?: { role?: string; usage?: Record<string, number>; content?: unknown } };
			const message = entry.message;
			if (!message) continue;
			if (message.role === "assistant" && message.usage) {
				totals.requests++;
				totals.input += message.usage.input ?? 0;
				totals.cacheRead += message.usage.cacheRead ?? 0;
				totals.cacheWrite += message.usage.cacheWrite ?? 0;
				totals.output += message.usage.output ?? 0;
				if (Array.isArray(message.content)) {
					const calls = message.content.filter((part: { type?: string }) => part.type === "toolCall") as { name?: string; arguments?: { command?: string } }[];
					totals.toolCalls += calls.length;
					for (const call of calls) {
						if (call.name === "web_search" || call.name === "web_fetch") totals.webToolCalls++;
						const command = call.name === "bash" ? String(call.arguments?.command ?? "") : "";
						if (NETWORK.test(command)) {
							totals.bashNetworkCalls++;
							totals.networkCommands.push(command.replace(/\s+/g, " ").slice(0, 160));
						}
					}
				}
			}
			if (message.role === "toolResult") {
				const text = JSON.stringify(message.content ?? "");
				totals.toolResultChars += text.length;
				totals.junaMarkers += (text.match(/\[juna[ :]/g) ?? []).length;
			}
		}
	}
	return totals;
}

function jev(path: string) {
	if (!existsSync(path)) return { jevRequests: 0, jevQuestions: 0, jevInputTokens: 0 };
	const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { questions: number; inputTokens: number | null });
	return {
		jevRequests: lines.length,
		jevQuestions: lines.reduce((sum, line) => sum + line.questions, 0),
		jevInputTokens: lines.reduce((sum, line) => sum + (line.inputTokens ?? 0), 0),
	};
}

const jobs: Job[] = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
	for (const task of SUITE.filter((entry) => onlyTasks.includes(entry.id))) {
		for (const arm of arms) jobs.push({ arm, task, repeat });
	}
}

mkdirSync(out, { recursive: true });
const results: Record<string, unknown>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++]!;
			try {
				results.push(await runOne(job));
			} catch (error) {
				console.error(`${job.task.id}-${job.arm}-${job.repeat}: harness error: ${(error as Error).message}`);
			}
		}
	}),
);
writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${join(out, "results.json")}`);
