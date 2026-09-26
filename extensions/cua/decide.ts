/**
 * What Jev decides in computer use, and nothing more. Jev picks among controls
 * code has already listed, judges whether a goal is met, and flags risk. It
 * never generates text, never sees a screenshot, and never decides whether an
 * irreversible action is allowed: code does, from Jev's answers plus a regex
 * over the control's raw label.
 */

import { renderRow, type El } from "./model.ts";

export interface Choice { choice?: string; confidence?: number; probabilities?: Record<string, number> }
export interface Noul { noul?: number }

/** Jev's Choice criteria get the ref as the option id and the row as its description. */
function options(candidates: { ref: string; el: El }[], none: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const { ref, el } of candidates) out[ref] = renderRow(ref, el).slice(ref.length + 1);
	out.none = none;
	return out;
}

/** Keep a choice bounded: past `max`, rank by word overlap with the request. */
export function shortlist<T extends { el: El }>(candidates: T[], request: string, max = 60): T[] {
	if (candidates.length <= max) return candidates;
	const words = new Set(request.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
	const score = (el: El) => `${el.role} ${el.label} ${el.value ?? ""}`.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
	return candidates.map((c, i) => ({ c, i, s: score(c.el) }))
		.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max)
		.sort((a, b) => a.i - b.i).map(({ c }) => c);
}

export function pickRequest(
	model: string, window: string, verb: string, description: string, candidates: { ref: string; el: El }[], task = "",
): Record<string, unknown> {
	return {
		model,
		state: { window, action_to_perform: verb, control_the_user_means: description, ...(task ? { overall_task: task } : {}) },
		questions: {
			target: {
				type: "choice",
				instructions: `Which listed control does the user mean by "control_the_user_means"? The agent will ${verb} it. Pick none unless one listed control clearly fits.`,
				criteria: options(candidates, "None of the listed controls is the one meant."),
			},
		},
	};
}

export const STEP_ACTIONS: Record<string, string> = {
	click: "Click or press the chosen control (buttons, menu items, tabs, checkboxes, list items, links).",
	set_text: "Replace the chosen text field's contents with the provided text. Only when text was provided and it belongs in that field.",
	press_enter: "Press Enter in the window, to submit or confirm what was just entered.",
	press_escape: "Press Escape, to dismiss a menu, popup or dialog that is in the way.",
	scroll_down: "Scroll the window down, when the needed control is probably below what is listed.",
	done: "Stop: the goal is already achieved in the current state.",
	stuck: "Stop: the goal cannot be reached from here with these actions (missing control, needs information the agent does not have, or a login/permission wall).",
};

export function stepRequest(
	model: string,
	goal: string,
	text: string | undefined,
	window: string,
	screen: string,
	history: string[],
	candidates: { ref: string; el: El }[],
): Record<string, unknown> {
	const actions = { ...STEP_ACTIONS };
	if (text === undefined) delete actions.set_text;
	return {
		model,
		state: {
			goal,
			text_to_enter: text === undefined ? "none provided" : text.slice(0, 500),
			window,
			controls_on_screen: screen,
			actions_taken_so_far: history.length ? history.join("\n") : "none yet",
		},
		questions: {
			action: {
				type: "choice",
				instructions: "What single next step moves toward the goal? Judge from the controls on screen and the actions already taken; never repeat an action that already happened unless the screen shows it failed.",
				criteria: actions,
			},
			target: {
				type: "choice",
				instructions: "If the next step clicks a control or fills a text field, which listed control? Otherwise none.",
				criteria: options(candidates, "No control is needed for the next step, or none of these fits."),
			},
			done: {
				type: "noul",
				instructions: "The controls on screen show that the goal has already been fully achieved.",
			},
			irreversible: {
				type: "noul",
				instructions: "Completing the goal requires an action that is hard to undo: sending, deleting, paying, purchasing, publishing, submitting a form to someone else, or changing system settings.",
			},
		},
	};
}

export function expectRequest(model: string, window: string, screen: string, changes: string, expectation: string): Record<string, unknown> {
	return {
		model,
		state: { window, controls_on_screen_now: screen, what_changed_after_the_action: changes || "nothing changed" },
		questions: {
			holds: {
				type: "noul",
				instructions: `After the action, this is true: ${expectation}`,
			},
		},
	};
}

/** A Noul probability, stated as words the calling model can act on. */
export function likelihood(p: number | undefined): string {
	if (typeof p !== "number") return "unknown";
	if (p >= 0.9) return `yes (${p.toFixed(2)})`;
	if (p >= 0.6) return `probably (${p.toFixed(2)})`;
	if (p > 0.4) return `unclear (${p.toFixed(2)})`;
	if (p > 0.1) return `probably not (${p.toFixed(2)})`;
	return `no (${p.toFixed(2)})`;
}
