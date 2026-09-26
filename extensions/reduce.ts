/**
 * Deterministic reducers for bash output. Pure functions, no I/O, no model.
 *
 * Measured on 90 benchmark sessions: colour codes were a quarter of all Jest
 * output, a failing Jest run printed every failure twice, and raw HTML from
 * curl made up nearly all over-long lines. Each reducer below removes one of
 * those, and each returns the input unchanged when it does not apply.
 */

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

/** Terminal colour and cursor codes carry nothing a model can read. */
export function stripAnsi(text: string): string {
	return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

/**
 * A carriage return redraws the line, so only the text after the last one was
 * ever visible: progress bars leave their final state. A trailing \r is a
 * Windows line ending, not a redraw.
 */
export function collapseRedraws(text: string): string {
	if (!text.includes("\r")) return text;
	return text
		.split("\n")
		.map((line) => {
			const body = line.endsWith("\r") ? line.slice(0, -1) : line;
			const last = body.lastIndexOf("\r");
			return last === -1 ? body : body.slice(last + 1);
		})
		.join("\n");
}

/** Lines that only report a passing test or suite, across common runners. */
const PASS_LINE = /^\s*(?:✓|√|✔|PASS\s|\(pass\)|ok\s+\d+\s|test .* \.\.\. ok$|.*\sPASSED(?:\s|$))/;

/** Full failure detail kept for this many failures; the rest are listed by title. */
export const FULL_FAILURES = 3;

export interface TestReduction {
	text: string;
	/** Failures shown by title only. */
	folded: number;
}

/**
 * Shrink test-runner output to what a fix needs: every failure's title, the
 * first few failures in full, and the summary. Passing lines go. Jest's
 * closing "Summary of all failing tests" repeats every failure already shown,
 * so it goes too. Anything that does not look like test output is untouched.
 */
export function reduceTestOutput(text: string, rerunHint = "rerun one test by name"): TestReduction {
	const lines = text.split("\n");
	const isJest = /^Test Suites:/m.test(text) || /^\s*● /m.test(text);
	const passing = lines.filter((line) => PASS_LINE.test(line)).length;
	if (!isJest && passing < 5) return { text, folded: 0 };

	let body = text;
	if (isJest) {
		// The summary section starts with its own header and repeats blocks verbatim.
		const summary = body.indexOf("\nSummary of all failing tests\n");
		if (summary !== -1) {
			const tail = body.slice(summary);
			const totals = tail.search(/^Test Suites:/m);
			body = body.slice(0, summary) + (totals === -1 ? "" : `\n${tail.slice(totals)}`);
		}
	}

	const out: string[] = [];
	let failures = 0;
	let folded = 0;
	let inFolded = false;
	let suiteShown = true;
	for (const line of body.split("\n")) {
		if (PASS_LINE.test(line)) continue;
		if (/^FAIL\s/.test(line)) suiteShown = false;
		if (isJest && /^\s*● /.test(line)) {
			failures++;
			// The first failures overall, and the first of every failing file, stay whole.
			inFolded = failures > FULL_FAILURES && suiteShown;
			suiteShown = true;
			if (inFolded) {
				folded++;
				out.push(line.trimEnd());
				continue;
			}
		} else if (inFolded) {
			// A folded block ends where the next suite or the totals begin.
			if (/^(FAIL|PASS)\s|^Test Suites:|^Tests:/.test(line)) inFolded = false;
			else continue;
		}
		out.push(line);
	}

	let result = out.join("\n").replace(/\n{3,}/g, "\n\n");
	if (folded > 0) {
		result += `\n\n[juna: ${folded} failures shown by title only. To see one, ${rerunHint}.]`;
	}
	return result.length < text.length ? { text: result, folded } : { text, folded: 0 };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** True when the output is an HTML document rather than text that mentions a tag. */
export function looksLikeHtml(text: string): boolean {
	const head = text.slice(0, 2000).toLowerCase();
	if (/<!doctype html|<html[\s>]/.test(head)) return true;
	const tags = text.match(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi)?.length ?? 0;
	return text.length > 2000 && tags * 40 > text.length;
}

/** Page text without scripts, styles, markup or entity noise. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
			if (code[0] === "#") {
				const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
				return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : entity;
			}
			return ENTITIES[code.toLowerCase()] ?? entity;
		})
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface Reduction {
	text: string;
	/** Short names of the reducers that changed something, for the status line. */
	applied: string[];
}

/** Every deterministic reducer, cheapest first. */
export function reduceBashOutput(text: string, rerunHint?: string): Reduction {
	const applied: string[] = [];
	let current = text;
	const step = (name: string, next: string) => {
		if (next !== current) {
			applied.push(name);
			current = next;
		}
	};
	step("ansi", stripAnsi(current));
	step("redraws", collapseRedraws(current));
	step("tests", reduceTestOutput(current, rerunHint).text);
	if (looksLikeHtml(current)) {
		const converted = htmlToText(current);
		if (converted.length < current.length * 0.8) step("html", `${converted}\n\n[juna: HTML converted to text.]`);
	}
	return { text: current, applied };
}
