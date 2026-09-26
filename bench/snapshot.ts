/**
 * Record the workspace the agent starts from, without leaving a trace inside it.
 *
 * The workspace loses its own .git, so `git diff` or `git status` cannot show
 * an agent what a task's setup changed. The baseline lives in a bare repository
 * next to the workspace instead, and grading diffs against it.
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

type Shell = (command: string) => { code: number; out: string };

export interface Snapshot {
	/** Files that differ from the starting state, limited to `paths`. */
	changed: (paths: string) => string[];
	/** The full diff from the starting state. */
	diff: () => string;
}

export function snapshot(work: string, sh: Shell): Snapshot {
	rmSync(join(work, ".git"), { recursive: true, force: true });
	const gitDir = join(dirname(work), "snapshot.git");
	const git = `git --git-dir=${JSON.stringify(gitDir)} --work-tree=.`;
	const init = sh(`git init -q --bare ${JSON.stringify(gitDir)}`);
	if (init.code !== 0) throw new Error(`snapshot: git init failed: ${init.out}`);
	const tree = sh(`${git} add -A && ${git} write-tree`);
	const baseline = tree.out.trim();
	if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(baseline)) throw new Error(`snapshot: write-tree failed: ${tree.out}`);
	return {
		changed: (paths) => sh(`${git} add -A && ${git} diff --cached --name-only ${baseline} -- ${paths}`).out.trim().split("\n").filter(Boolean),
		diff: () => sh(`${git} add -A && ${git} diff --cached --binary ${baseline}`).out,
	};
}
