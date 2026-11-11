// Every visible string of the special-keys menu and the typing time (S16b), as approved: design/COPY.md rows owned
// by S16b ("Typing time", "Typing ran out", "Key menu: ..."), and the operator's 2026-11-11 answers for a failed
// press and a closed terminal. `host` is the computer's name ("desk-1"), `agent` the agent's name ("Agent 1").

/** Key menu: button. */
export const KEYS_BUTTON = "Keys";
export const KEYS_BUTTON_LABEL = "Keys: open the special keys menu";
/** Key menu: sheet. */
export const KEYS_TITLE = "Keys";
export const keysSub = (agent: string): string => `Pressed at once in ${agent}'s terminal.`;
export const keysSubOff = (agent: string): string => `${agent}'s terminal`;
export const YOUR_KEYS = "Your keys";
export const keysFoot = (host: string): string => `Change this list in keys.json on ${host}.`;
/** Key menu: pressed. */
export const pressedWords = (label: string): string => `Pressed ${label}.`;
/** Key menu: off. */
export const keysOff = (host: string): string => `Special keys are off for this phone. Turn them on in Remote on ${host}.`;
/** Key menu: list changed. */
export const keysChanged = (host: string): string => `The key list changed on ${host}. Look again.`;
/** Key menu: dialog open. */
export const KEYS_DIALOG = "The agent is waiting on a dialog at the desktop. Nothing was pressed.";
/** Operator, 2026-11-11: any other failed press. */
export const pressFailed = (label: string): string => `Couldn't press ${label}. Try again.`;
/** Operator, 2026-11-11: the terminal has closed. */
export const terminalClosed = (agent: string): string => `${agent}'s terminal is closed.`;

/** Typing time. */
export const typingUntil = (clock: string): string => `Typing is on until ${clock}`;
export const typingSoon = (minutes: number, clock: string): string => `Typing turns off in ${minutes} min, at ${clock}`;
/** Typing ran out. */
export const typingRanOut = (clock: string): string => `Typing turned off at ${clock}.`;
export const typingRanOutHow = (host: string): string => `Turn it on again in Remote on ${host}.`;
