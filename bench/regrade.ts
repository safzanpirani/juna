#!/usr/bin/env bun
/**
 * Grade every run again from its saved diff, one at a time, on a fresh copy of
 * the fixture. Use it when a grade may have been disturbed by load from runs in
 * parallel. Rewrites each result.json and results.json in place.
 *
 *   bun bench/regrade.ts --fixture /tmp/commander --out /tmp/juna-bench
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { snapshot } from "./snapshot.ts";
import { TASKS } from "./tasks.ts";

function flag(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) throw new Error(`--${name} is required`);
	return process.argv[index + 1]!;
}

const fixture = resolve(flag("fixture"));
const out = resolve(flag("out"));
const results: Record<string, unknown>[] = [];

for (const name of readdirSync(join(out, "runs")).sort()) {
	const runDir = join(out, "runs", name);
	if (!existsSync(join(runDir, "result.json"))) continue;
	const record = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as Record<string, unknown> & { task: string; passed: boolean; note: string };
	const task = TASKS.find((entry) => entry.id === record.task);
	if (!task) throw new Error(`${name}: unknown task ${record.task}`);

	const work = join(mkdtempSync(join(tmpdir(), "juna-regrade-")), "repo");
	Bun.spawnSync(["cp", "-cR", fixture, work]);
	const sh = (command: string) => {
		const result = Bun.spawnSync(["bash", "-c", command], { cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
		return { code: result.exitCode, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
	};
	task.setup?.(work);
	const start = snapshot(work, sh);
	const patch = join(runDir, "diff.patch");
	// git apply works outside a repository, which the workspace now is.
	const applied = readFileSync(patch, "utf8").trim() === "" ? { code: 0, out: "" } : sh(`git apply --binary ${JSON.stringify(patch)}`);
	const grade = applied.code === 0 ? task.grade(work, sh, start.changed) : { passed: false, note: `diff did not apply: ${applied.out.trim()}` };
	rmSync(join(work, ".."), { recursive: true, force: true });

	if (grade.passed !== record.passed) console.log(`${name}: ${record.passed ? "PASS" : "FAIL"} -> ${grade.passed ? "PASS" : "FAIL"} (${record.note} -> ${grade.note})`);
	const updated = { ...record, ...grade, regraded: true, firstGrade: { passed: record.passed, note: record.note } };
	writeFileSync(join(runDir, "result.json"), `${JSON.stringify(updated, null, 2)}\n`);
	results.push(updated);
}

writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`regraded ${results.length} runs`);
