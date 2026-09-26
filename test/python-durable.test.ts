import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonRuntime } from "../extensions/python/runtime.ts";

const runtimes: PythonRuntime[] = [];
const directories: string[] = [];
const bridge = async () => { throw new Error("Unexpected bridge call"); };
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "juna-durable-test-"));
	directories.push(path);
	return path;
}
function runtime(path: string) {
	const result = new PythonRuntime();
	result.useSession(path);
	runtimes.push(result);
	return result;
}
afterEach(async () => {
	for (const r of runtimes.splice(0)) r.reset("test finished");
	for (const path of directories.splice(0)) await rm(path, { force: true, recursive: true });
});

test("a new runtime restores data, aliases, functions, classes, imports and cwd without replay", async () => {
	const dir = await directory();
	const state = join(dir, "state");
	const first = runtime(state);
	await first.run(`import os, math
from pathlib import Path
rows = list(range(10000))
alias = rows
def total(): return sum(rows)
class Counter:
    def count(self): return len(rows)
counter = Counter()
Path('effects').write_text('once')
os.chdir(${JSON.stringify(dir)})`, dir, bridge);
	first.reset("simulated restart");
	await rm(join(dir, "effects"));
	const second = runtime(state);
	const result = await second.run("rows.append(10000)\nprint(total(), rows is alias, counter.count(), math.sqrt(16), os.getcwd(), Path('effects').exists())", tmpdir(), bridge);
	expect(result.text).toContain("50005000 True 10001 4.0");
	expect(result.text).toContain(`${dir} False`);
	expect((await stat(join(state, "state.bin"))).mode & 0o777).toBe(0o600);
	expect((await stat(state)).mode & 0o777).toBe(0o700);
});

test("crash and timeout recover the last checkpoint and warn about incomplete effects", async () => {
	const dir = await directory();
	const r = runtime(join(dir, "state"));
	await r.run("value = 7", dir, bridge);
	await expect(r.run("import os\nvalue = 9\nos._exit(3)", dir, bridge)).rejects.toThrow("process exited");
	const recovered = await r.run("print(value)", dir, bridge);
	expect(recovered.text).toContain("7");
	expect(recovered.text).toContain("Previous cell was interrupted");
	await expect(r.run("value = 12\nwhile True: pass", dir, bridge, undefined, 100)).rejects.toThrow("timed out");
	expect((await r.run("print(value)", dir, bridge)).text).toContain("7");
});

test("ordinary errors checkpoint partial state and deletion survives restart", async () => {
	const dir = await directory();
	const r = runtime(dir);
	await r.run("values = []; removed = 1", tmpdir(), bridge);
	await expect(r.run("values.append(3)\ndel removed\nraise ValueError('expected')", tmpdir(), bridge)).rejects.toThrow("ValueError");
	r.reset("restart");
	expect((await r.run("print(values, 'removed' in globals())", tmpdir(), bridge)).text).toContain("[3] False");
});

test("unsupported values fail checkpointing explicitly and preserve the previous bytes", async () => {
	const dir = await directory();
	const r = runtime(dir);
	await r.run("value = 7", tmpdir(), bridge);
	const before = await readFile(join(dir, "state.bin"));
	await expect(r.run("import socket\nconnection = socket.socket()\nvalue = 8", tmpdir(), bridge)).rejects.toThrow("Unsupported variables: connection");
	expect(await readFile(join(dir, "state.bin"))).toEqual(before);
	await r.run("connection.close()\ndel connection\nprint(value)", tmpdir(), bridge);
	r.reset("restart");
	expect((await r.run("print(value)", tmpdir(), bridge)).text).toContain("8");
});

test("corrupt checkpoints fail before executing any new cell and are never overwritten", async () => {
	const dir = await directory();
	await writeFile(join(dir, "state.bin"), "corrupt");
	const r = runtime(dir);
	await expect(r.run("open('must-not-exist', 'w').write('bad')", dir, bridge)).rejects.toThrow("No cell was executed");
	expect(await readFile(join(dir, "state.bin"), "utf8")).toBe("corrupt");
	await expect(stat(join(dir, "must-not-exist"))).rejects.toThrow();
});

test("one session cannot have two checkpoint writers", async () => {
	const dir = await directory();
	const owner = runtime(dir);
	await owner.run("value = 1", tmpdir(), bridge);
	const competing = runtime(dir);
	await expect(competing.run("value = 2", tmpdir(), bridge)).rejects.toThrow("already open in another process");
	expect((await owner.run("print(value)", tmpdir(), bridge)).text).toBe("1\n");
});

test("switching sessions isolates state; explicit clearing is durable", async () => {
	const a = await directory(), b = await directory();
	const r = runtime(a);
	await r.run("value = 'a'", tmpdir(), bridge);
	r.useSession(b);
	expect((await r.run("print('value' in globals())", tmpdir(), bridge)).text).toContain("False");
	await r.run("value = 'b'", tmpdir(), bridge);
	r.useSession(a);
	expect((await r.run("print(value)", tmpdir(), bridge)).text).toContain("a");
	r.clear();
	await r.run("", tmpdir(), bridge);
	r.reset("restart");
	expect((await r.run("print('value' in globals())", tmpdir(), bridge)).text).toContain("False");
});
