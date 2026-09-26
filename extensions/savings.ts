/**
 * One counter, shared by the extension that prunes and the one that reports.
 *
 * Node caches a module per path, so both extensions importing this file get the
 * same object. That is the whole mechanism: no globals, no event plumbing.
 */

let savedChars = 0;

/** Record a saving and hand it back, so callers can keep their own tally inline. */
export function addSaved(chars: number): number {
	if (Number.isFinite(chars) && chars > 0) savedChars += chars;
	return chars;
}

export function totalSaved(): number {
	return savedChars;
}

export function resetSaved(): void {
	savedChars = 0;
}
