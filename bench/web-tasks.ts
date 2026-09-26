/**
 * Tasks that need live information from the web. Stock Pi has no web tool, so
 * these measure whether the model finds another way through bash (curl, npm,
 * gh) or fails. Ground truth is fetched when grading, never hard-coded, so a
 * task stays correct after the next release.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Grade, Task } from "./tasks.ts";

const CHANGELOG_URL = "https://raw.githubusercontent.com/tj/commander.js/master/CHANGELOG.md";

function answer(dir: string, file: string): string | undefined {
	const path = join(dir, file);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

async function text(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return response.text();
}

/** Every released version after 14.0.0, with the PR numbers its section cites. */
export function changesAfter14(changelog: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	const pattern = /^## \[(\d+\.\d+\.\d+)\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm;
	for (const match of changelog.matchAll(pattern)) {
		const [major, minor, patch] = match[1]!.split(".").map(Number) as [number, number, number];
		if (major < 14 || (major === 14 && minor === 0 && patch === 0)) continue;
		const prs = [...new Set([...match[2]!.matchAll(/\[#(\d+)\]/g)].map((pr) => pr[1]!))];
		sections.set(match[1]!, prs);
	}
	return sections;
}

const UNITS: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mtok: 1e6, billion: 1e9, b: 1e9 };

/** "$42 per billion" or "$0.042 / 1M tokens" as dollars per single token. */
export function pricePerToken(line: string): number | undefined {
	const match = /\$\s*([\d.,]+)\s*(?:per|\/)\s*(?:1\s*)?([a-z]+)/i.exec(line);
	if (!match) return undefined;
	const dollars = Number(match[1]!.replace(/,/g, ""));
	const unit = UNITS[match[2]!.toLowerCase()];
	return Number.isFinite(dollars) && unit ? dollars / unit : undefined;
}

export const WEB_TASKS: Task[] = [
	{
		id: "npm",
		prompt:
			"What is the newest version of the `commander` package published on the npm registry right now, and on what date (UTC) was it published? Look it up; do not rely on memory or on this repository, which is older. Write exactly two lines to ANSWER.md: `version: X.Y.Z` and `date: YYYY-MM-DD`.",
		async gradeAsync(dir): Promise<Grade> {
			const body = answer(dir, "ANSWER.md");
			if (!body) return { passed: false, note: "no ANSWER.md" };
			const registry = JSON.parse(await text("https://registry.npmjs.org/commander")) as { "dist-tags": { latest: string }; time: Record<string, string> };
			const version = registry["dist-tags"].latest;
			const date = registry.time[version]!.slice(0, 10);
			const gotVersion = /version:\s*v?(\S+)/i.exec(body)?.[1];
			const gotDate = /date:\s*(\d{4}-\d{2}-\d{2})/i.exec(body)?.[1];
			return { passed: gotVersion === version && gotDate === date, note: `got ${gotVersion ?? "-"} ${gotDate ?? "-"}, want ${version} ${date}` };
		},
	},
	{
		id: "changelog",
		prompt:
			"This repository is commander v14.0.0. Upstream has shipped releases since then. Read the upstream changelog and write UPGRADE.md: one section per release after 14.0.0 (newest first), each listing every change in that release with its pull request number written as #1234. Do not change any other file.",
		async gradeAsync(dir): Promise<Grade> {
			const body = answer(dir, "UPGRADE.md");
			if (!body) return { passed: false, note: "no UPGRADE.md" };
			const truth = changesAfter14(await text(CHANGELOG_URL));
			const missingVersions = [...truth.keys()].filter((version) => !body.includes(version));
			const prs = [...truth.values()].flat();
			const cited = prs.filter((pr) => new RegExp(`#${pr}\\b`).test(body));
			const share = prs.length ? cited.length / prs.length : 0;
			return {
				passed: missingVersions.length === 0 && share >= 0.8,
				note: `${truth.size - missingVersions.length}/${truth.size} releases, ${cited.length}/${prs.length} PRs${missingVersions.length ? `; missing ${missingVersions.join(", ")}` : ""}`,
			};
		},
	},
	{
		id: "price",
		prompt:
			"TypeSafe sells an AI model called Jev (their \"System One\" model). Find out what TypeSafe charges for Jev's input tokens, from TypeSafe's own website. Write one line to ANSWER.md in the form `price: $N per <unit> input tokens`, using the unit TypeSafe quotes.",
		async gradeAsync(dir): Promise<Grade> {
			const body = answer(dir, "ANSWER.md");
			if (!body) return { passed: false, note: "no ANSWER.md" };
			const line = body.split("\n").find((entry) => /price:/i.test(entry)) ?? body.trim().split("\n")[0] ?? "";
			// TypeSafe quotes $42 per billion. Any equivalent price is correct.
			const perToken = pricePerToken(line);
			const passed = perToken !== undefined && Math.abs(perToken - 42e-9) < 1e-12;
			return { passed, note: `answered "${line.trim().slice(0, 80)}"` };
		},
	},
];
