#!/usr/bin/env bun
/**
 * Check that juna can reach TypeSafe (Jev) and Exa with the keys it would use.
 *
 *   bun scripts/check-keys.ts
 *
 * Keys are read exactly as juna reads them: TYPESAFE_API_KEY and EXA_API_KEY
 * from the environment first, then apiKey and exaApiKey from juna.json in the
 * profile (JUNA_DIR, default ~/.pi/juna). Each check makes one real call: a
 * one-question Jev request and one short Exa page read, about $0.001 in total.
 * Keys are never printed. Exits 1 when a key that is present fails.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchPage, loadExaConfig } from "../extensions/exa.ts";
import { askJev, configPath, loadConfig } from "../extensions/jev.ts";

const env = { ...process.env, PI_CODING_AGENT_DIR: process.env.JUNA_DIR ?? join(homedir(), ".pi", "juna") };
let failed = false;

const jev = loadConfig(env);
if (!jev.apiKey) {
	console.log(`TypeSafe: no key. Set TYPESAFE_API_KEY, or add "apiKey" to ${configPath(env)}. Jev pruning stays off.`);
} else {
	try {
		const response = await askJev(
			{ model: jev.model, state: "The sky is blue.", questions: { check: { type: "noul", instructions: "The statement is about the sky." } } },
			jev,
		);
		const answer = response.answers?.check as { noul?: number } | undefined;
		if (typeof answer?.noul !== "number") throw new Error("the reply had no answer");
		console.log(`TypeSafe: OK (${jev.model}, answered yes with probability ${answer.noul.toFixed(2)})`);
	} catch (error) {
		failed = true;
		console.log(`TypeSafe: FAILED. ${(error as Error).message}`);
	}
}

// The skill picker reads its own file, which the launcher links to juna.json when absent.
if (jev.apiKey) {
	const pickerFile = join(env.PI_CODING_AGENT_DIR, "skill-jev.json");
	let pickerKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());
	try {
		pickerKey ||= Boolean((JSON.parse(readFileSync(pickerFile, "utf8")) as { apiKey?: string }).apiKey?.trim());
	} catch {
		// Missing or unreadable: reported below.
	}
	console.log(pickerKey ? "Skill picker: key found" : `Skill picker: no key. Run juna once to link ${pickerFile} to juna.json, or set TYPESAFE_API_KEY.`);
	if (!pickerKey) failed = true;
}

const exa = loadExaConfig(env);
if (!exa.apiKey) {
	console.log(`Exa: no key. Set EXA_API_KEY, or add "exaApiKey" to ${join(env.PI_CODING_AGENT_DIR, "juna.json")}. web_search and web_fetch stay off.`);
} else {
	try {
		const page = await fetchPage("https://example.com", 200, exa);
		console.log(`Exa: OK (read ${page.url}, ${page.text.length} characters)`);
	} catch (error) {
		failed = true;
		console.log(`Exa: FAILED. ${(error as Error).message}`);
	}
}

process.exit(failed ? 1 : 0);
