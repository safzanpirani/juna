/**
 * Durable CodeMode checkpoints need Python with dill 0.4.1 (setup guide, step 7).
 * Tests that restore a checkpoint are skipped, with one note, when it is absent,
 * so a fresh clone without the optional Python setup still passes its check.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function interpreter(): string {
	if (process.env.JUNA_PYTHON) return process.env.JUNA_PYTHON;
	const managed = join(process.env.JUNA_DIR || join(homedir(), ".pi/juna"), "python-venv/bin/python");
	return existsSync(managed) ? managed : "python3";
}

function probe(): boolean {
	try {
		const result = Bun.spawnSync([interpreter(), "-c", "import dill, sys; sys.exit(0 if dill.__version__ == '0.4.1' else 1)"], { stdout: "ignore", stderr: "ignore" });
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

export const hasDill = probe();
if (!hasDill) console.warn("[juna tests] Python with dill==0.4.1 not found; skipping durable CodeMode tests (see setup step 7).");
