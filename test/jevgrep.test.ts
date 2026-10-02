import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension, { buildArgs, GUIDANCE, interpret, loadJgSettings } from "../extensions/jevgrep.ts";

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake jg that logs its argv and stdin, then prints the given packet and exits with the given code. */
function fakeJg(stdout: string, code = 0, credentials = true) {
	const dir = mkdtempSync(join(tmpdir(), "juna-jg-"));
	dirs.push(dir);
	const log = join(dir, "calls.log");
	const bin = join(dir, "jg");
	writeFileSync(join(dir, "out.txt"), stdout);
	writeFileSync(
		bin,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = auth ]; then cat >> '${log}'; echo >> '${log}'; exit 0; fi\ncat '${join(dir, "out.txt")}'\nexit ${code}\n`,
	);
	chmodSync(bin, 0o755);
	Object.assign(process.env, {
		JUNA_JG_BIN: bin,
		XDG_CONFIG_HOME: join(dir, "config"),
		PI_CODING_AGENT_DIR: dir,
		TYPESAFE_API_KEY: "test-only-key",
	});
	if (credentials) {
		Bun.spawnSync(["mkdir", "-p", join(dir, "config", "jevgrep")]);
		writeFileSync(join(dir, "config", "jevgrep", "credentials.json"), "{}");
	}
	const registered: ToolDefinition[] = [];
	const handlers: Record<string, () => void> = {};
	extension({ registerTool: (tool: ToolDefinition) => registered.push(tool), on: (name: string, fn: () => void) => (handlers[name] = fn) } as unknown as ExtensionAPI);
	const tool = registered.find((t) => t.name === "code_search")!;
	const call = async (params: Record<string, unknown>) => {
		const result = await tool.execute("t", params as never, undefined, undefined, { cwd: dir } as never);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	};
	return { dir, call, calls: () => readFileSync(log, "utf8"), handlers };
}

describe("code_search", () => {
	test("adds the research rules to the first result of a session only", async () => {
		const { call, handlers } = fakeJg("Jevgrep: 1 relevant file.\nEnd context.");
		const first = await call({ question: "where are events recorded" });
		expect(first.startsWith(GUIDANCE)).toBe(true);
		expect(first).toEndWith("End context.");
		expect(await call({ question: "where are events recorded" })).toBe("Jevgrep: 1 relevant file.\nEnd context.");
		handlers.session_start!();
		expect((await call({ question: "where are events recorded" })).startsWith(GUIDANCE)).toBe(true);
	});

	test("passes the budget and resolves root against the working directory", async () => {
		const { dir, call, calls } = fakeJg("packet");
		await call({ question: "how is pooling configured", root: "src" });
		expect(calls().trim()).toBe(`--max-source-bytes 60000 how is pooling configured -- ${join(dir, "src")}`);
	});

	test("saves juna's key for jg through stdin when jg has no credentials", async () => {
		const { call, calls } = fakeJg("packet", 0, false);
		await call({ question: "how is pooling configured" });
		const lines = calls().split("\n");
		expect(lines[0]).toBe("auth --provider typesafe --stdin");
		expect(lines[1]).toBe("test-only-key");
		expect(calls()).not.toContain("--stdin test-only-key");
	});

	test("an incomplete result is still returned; a failure throws", async () => {
		expect(await fakeJg("partial packet", 2).call({ question: "where is retry handled" })).toContain("[juna: jevgrep reported an incomplete result.");
		await expect(fakeJg("", 1).call({ question: "where is retry handled" })).rejects.toThrow("Use ordinary discovery");
	});
});

describe("helpers", () => {
	test("a missing binary names the install command", () => {
		const error = Object.assign(new Error("spawn jg ENOENT"), { code: "ENOENT" });
		expect(interpret({ code: null, stdout: "", stderr: "", error }, "jg")).toEqual({ error: expect.stringContaining("npm install --global @dzhng/jevgrep") });
	});

	test("settings read the environment and --no-cache is opt-in", () => {
		const settings = loadJgSettings({ JUNA_JG_MAX_SOURCE_BYTES: "0", JUNA_JG_NO_CACHE: "1" });
		expect(settings.maxSourceBytes).toBe(0);
		expect(buildArgs("q", "/r", settings)).toEqual(["--max-source-bytes", "0", "--no-cache", "q", "--", "/r"]);
		expect(loadJgSettings({ JUNA_JG_MAX_SOURCE_BYTES: "x" }).maxSourceBytes).toBe(60_000);
	});
});
