/**
 * Say whether a test, build or lint run passed, on the line above its output.
 *
 * A failing run whose output has just been pruned is the case that matters: the
 * model sees an excerpt and has to infer the verdict from it. One line stating
 * the outcome removes the inference.
 *
 * The questions ride along in the batch `jev-prune` already sends, so a verdict
 * costs no extra round trip. That is also why verification only happens on the
 * pruning path: output small enough to arrive whole is output the model can
 * read for itself.
 */

/** Commands whose whole purpose is to report a pass or a fail. */
const RUNNERS = [
	/\b(bun|npm|pnpm|yarn|deno)\s+(run\s+)?(test|check|lint|typecheck|build)\b/,
	/\b(vitest|jest|mocha|ava|playwright|cypress)\b/,
	/\bpytest\b|\bpython\s+-m\s+(pytest|unittest)\b/,
	/\bcargo\s+(test|build|check|clippy)\b/,
	/\bgo\s+(test|build|vet)\b/,
	/\b(tsc|eslint|biome|ruff|mypy|rubocop|golangci-lint)\b/,
	/\bmake\s+(test|check|lint|build)\b/,
	/\bgradlew?\s+(test|build)\b|\bmvn\s+(test|verify|package)\b/,
	/\bdotnet\s+(test|build)\b/,
];

export function isRunner(command: string): boolean {
	return RUNNERS.some((pattern) => pattern.test(command));
}

export const OUTCOME_ID = "verify_outcome";
export const REPEAT_ID = "verify_repeat";

const OUTCOMES = {
	passed: "Everything the command ran succeeded. No failures, no errors.",
	failed: "The command ran and reported failures: failing tests, compile errors, lint violations.",
	did_not_run: "The command never got started: a missing dependency, a wrong path, a crash before the work began.",
	mixed: "Some of the work succeeded and some failed.",
} as const;

export type Outcome = keyof typeof OUTCOMES;

/**
 * The part of a run that carries its verdict: the head, where a crash or a
 * usage error appears, and the tail, where a summary line does. The middle of a
 * test run is per-case noise.
 */
export function digest(text: string, limit = 2_000): string {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.35);
	const tail = limit - head;
	return `${text.slice(0, head)}\n[… middle omitted …]\n${text.slice(-tail)}`;
}

/**
 * Two questions to append to the batch. The output has to travel inside the
 * question: the shared state holds the task, and the chunk questions each hold
 * one excerpt, so a question that did not carry the output would be answering
 * from the command name alone.
 *
 * `previousFailure` is the head of the last failure for this same command, so a
 * repeat is recognisable; the comparison is a judgement about text, which is
 * what Jev is for, while the bookkeeping stays in code.
 */
export function verifyQuestions(command: string, output: string, previousFailure?: string): Record<string, unknown> {
	const questions: Record<string, unknown> = {
		[OUTCOME_ID]: {
			type: "choice",
			instructions: {
				judgement:
					"This is the output of a command that reports a pass or a fail. Read it and say what happened. Judge the output, not the command name.",
				command,
				output: digest(output),
			},
			criteria: OUTCOMES,
		},
	};

	if (previousFailure) {
		questions[REPEAT_ID] = {
			type: "noul",
			instructions: {
				judgement: "The failure in this output is the same failure as the earlier one quoted here, not a different one.",
				earlier_failure: previousFailure,
			},
		};
	}
	return questions;
}

export interface Answer {
	choice?: string;
	noul?: number;
	confidence?: number;
}

export interface VerdictOptions {
	/** Below this confidence the verdict is not stated at all. */
	minConfidence: number;
}

/**
 * The line that goes above the output, or undefined when Jev was unsure. A
 * confident wrong verdict on a test run is worse than no verdict, so an
 * unconfident answer says nothing rather than hedging.
 */
export function verdictLine(
	answers: Record<string, Answer | undefined>,
	options: VerdictOptions,
	extra?: string,
): string | undefined {
	const outcome = answers[OUTCOME_ID];
	const choice = outcome?.choice;
	if (!choice || !(choice in OUTCOMES)) return undefined;
	if (typeof outcome?.confidence === "number" && outcome.confidence < options.minConfidence) return undefined;

	const said: Record<Outcome, string> = {
		passed: "passed",
		failed: "FAILED",
		did_not_run: "did not run",
		mixed: "partly failed",
	};

	const repeat = answers[REPEAT_ID];
	const again = choice !== "passed" && typeof repeat?.noul === "number" && repeat.noul >= 0.7 ? ", same failure as before" : "";
	return `[juna: ${said[choice as Outcome]}${again}${extra ? `. ${extra}` : ""}]`;
}

/** The part of a failing output worth quoting back next time. */
export function failureHead(text: string, limit = 400): string | undefined {
	const lines = text.split("\n").filter((line) => line.trim());
	const marker = lines.findIndex((line) => /\b(fail|error|panic|assert|✗|✘)\b/i.test(line));
	if (marker === -1) return lines.slice(0, 3).join("\n").slice(0, limit) || undefined;
	return lines.slice(marker, marker + 4).join("\n").slice(0, limit);
}
