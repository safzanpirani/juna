#!/usr/bin/env bun
/**
 * Report what a Pi profile costs at turn 0: the first request, with nothing in
 * history. The captured payload is real; token counts use a local tokenizer and do not
 * represent provider billing.
 *
 *   bun scripts/context-report.ts                    # the juna profile
 *   bun scripts/context-report.ts --bare             # same profile, extensions off
 *   bun scripts/context-report.ts --diff             # both, side by side
 *   bun scripts/context-report.ts --dir ~/.pi/other  # a different profile
 *   bun scripts/context-report.ts --stock            # stock Pi vs juna
 *   bun scripts/context-report.ts --stock --no-skills
 *
 * --stock builds a throwaway Pi profile with default settings (same model and
 * credentials as juna) and runs plain `pi` against it. Both sides run from an
 * empty working directory, so no project AGENTS.md is counted. Stock Pi still
 * discovers global skills (~/.agents/skills and the like); --no-skills hides them.
 *
 * It runs Pi with scripts/dump-context.ts, which captures the payload and exits
 * before the request is sent. No model is called and no tokens are spent.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "gpt-tokenizer";

const repo = join(import.meta.dir, "..");
const tokens = (text: string) => encode(text).length;
const has = (name: string) => process.argv.includes(`--${name}`);

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

interface Payload {
	messages?: { role?: string; content?: unknown }[];
	system?: unknown;
	instructions?: unknown;
	input?: { role?: string; content?: unknown }[];
	tools?: { function?: { name?: string }; name?: string }[];
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => text((part as { text?: unknown }).text ?? part)).join("\n");
	return value === undefined ? "" : JSON.stringify(value);
}

/** The system prompt as the provider sees it, whichever shape the API uses. */
function systemPrompt(payload: Payload): string {
	if (payload.instructions !== undefined) return text(payload.instructions);
	if (payload.system !== undefined) return text(payload.system);
	return (payload.messages ?? payload.input ?? []).filter((entry) => entry.role === "system" || entry.role === "developer").map((entry) => text(entry.content)).join("\n");
}

/** Sections are `<tag> … </tag>` blocks at the top level of the prompt. */
function sections(prompt: string): { tag: string; text: string }[] {
	const found: { tag: string; text: string }[] = [];
	const pattern = /^<([a-z_]+)>\n[\s\S]*?\n<\/\1>/gm;
	let match: RegExpExecArray | null;
	let covered = 0;
	while ((match = pattern.exec(prompt)) !== null) {
		const preamble = prompt.slice(covered, match.index).trim();
		if (preamble) found.push({ tag: "(preamble)", text: preamble });
		found.push({ tag: match[1]!, text: match[0] });
		covered = match.index + match[0].length;
	}
	const tail = prompt.slice(covered).trim();
	if (tail) found.push({ tag: "(tail)", text: tail });
	return found;
}

interface Run {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

function capture(run: Run): Payload {
	const out = join(mkdtempSync(join(tmpdir(), "juna-ctx-")), "dump.json");
	const args = ["-e", join(repo, "scripts", "dump-context.ts"), ...run.args, "--no-session", "-p", "x"];
	const result = Bun.spawnSync([run.command, ...args], {
		env: { ...process.env, ...run.env, JUNA_DUMP_PATH: out },
		cwd: run.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		return (JSON.parse(readFileSync(out, "utf8")) as { payload: Payload }).payload;
	} catch {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`No dump was written. pi exited ${result.exitCode}.${stderr ? `\n${stderr}` : ""}`);
	} finally {
		rmSync(join(out, ".."), { recursive: true, force: true });
	}
}

function juna(dir: string | undefined, bare: boolean, cwd?: string): Run {
	return { command: join(repo, "bin", "juna"), args: bare ? ["--no-extensions"] : [], env: dir ? { JUNA_DIR: dir } : {}, cwd };
}

/** A fresh Pi profile with default settings, borrowing juna's model and credentials. */
function stockProfile(junaDir: string): string {
	const profile = mkdtempSync(join(tmpdir(), "juna-stock-"));
	const settings = JSON.parse(readFileSync(join(junaDir, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
	writeFileSync(join(profile, "settings.json"), JSON.stringify({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel }));
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		if (existsSync(join(junaDir, file))) symlinkSync(join(junaDir, file), join(profile, file));
	}
	return profile;
}

function report(label: string, payload: Payload): number {
	const prompt = systemPrompt(payload);
	const promptTokens = tokens(prompt);
	const toolTokens = tokens(JSON.stringify(payload.tools ?? []));
	const total = tokens(JSON.stringify(payload));

	console.log(`\n${label}`);
	console.log("=".repeat(label.length));
	for (const section of sections(prompt).sort((a, b) => tokens(b.text) - tokens(a.text))) {
		const count = tokens(section.text);
		const share = promptTokens === 0 ? 0 : Math.round((count / promptTokens) * 100);
		console.log(`  ${section.tag.padEnd(18)} ${String(count).padStart(7)} tok  ${String(share).padStart(3)}%`);
	}
	console.log(`  ${"-".repeat(18)} ${"-".repeat(7)}`);
	console.log(`  ${"system prompt".padEnd(18)} ${String(promptTokens).padStart(7)} tok`);
	console.log(`  ${"tool schemas".padEnd(18)} ${String(toolTokens).padStart(7)} tok`);
	for (const tool of payload.tools ?? []) {
		const name = tool.function?.name ?? tool.name ?? "?";
		console.log(`    ${name.padEnd(16)} ${String(tokens(JSON.stringify(tool))).padStart(7)} tok`);
	}
	console.log("  Counts use gpt-tokenizer; component estimates are not additive or provider billing.");
	console.log(`  ${"serialized payload".padEnd(18)} ${String(total).padStart(7)} tok`);
	return total;
}

const dir = flag("dir");
if (has("stock")) {
	const junaDir = dir ?? process.env.JUNA_DIR ?? join(homedir(), ".pi", "juna");
	const cwd = mkdtempSync(join(tmpdir(), "juna-cwd-"));
	const profile = stockProfile(junaDir);
	try {
		const stock = report(`turn 0, stock pi${has("no-skills") ? " (--no-skills)" : ""}`, capture({ command: "pi", args: has("no-skills") ? ["--no-skills"] : [], env: { PI_CODING_AGENT_DIR: profile }, cwd }));
		const full = report("turn 0, juna", capture(juna(dir, false, cwd)));
		console.log(`\n  ${stock} -> ${full} tok: saved ${stock - full} (${Math.round(((stock - full) / stock) * 100)}%)\n`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(profile, { recursive: true, force: true });
	}
} else if (has("diff")) {
	const bare = report("turn 0, extensions off", capture(juna(dir, true)));
	const full = report("turn 0, juna", capture(juna(dir, false)));
	console.log(`\n  ${bare} -> ${full} tok: saved ${bare - full} (${Math.round(((bare - full) / bare) * 100)}%)\n`);
} else {
	report(has("bare") ? "turn 0, extensions off" : "turn 0, juna", capture(juna(dir, has("bare"))));
}
