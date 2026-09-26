import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("capture child exits before request continuation on both write success and failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "juna-dump-test-"));
	try {
		const script = `import dump from ${JSON.stringify(join(import.meta.dir, "../scripts/dump-context.ts"))}; dump({on(_name, hook) { hook({payload: {messages: []}}); console.log("REQUEST WOULD CONTINUE"); }});`;
		for (const [path, code] of [[join(dir, "dump.json"), 0], [join(dir, "missing", "dump.json"), 1]] as const) {
			const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, JUNA_DUMP_PATH: path } });
			expect(result.exitCode).toBe(code);
			expect(result.stdout.toString()).not.toContain("REQUEST WOULD CONTINUE");
		}
		expect(JSON.parse(readFileSync(join(dir, "dump.json"), "utf8"))).toEqual({ payload: { messages: [] } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
