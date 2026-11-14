import * as clack from "@clack/prompts";

/**
 * Command output. In a terminal it's @clack/prompts (boxes, colours, an
 * animated spinner). Otherwise (piped, captured by an agent or a script,
 * or JADE_PLAIN=1) it's plain lines: no escape codes, no animation, one line
 * per message, each starting with a word that says what it is. The wording
 * is the same in both, so docs and agents can quote either. JADE_PLAIN=0
 * forces the terminal look.
 *
 * A command printing JSON calls `setJsonMode(true)` first: everything here goes
 * quiet so stdout holds only the JSON, and `cancel` writes
 * `{"error":{"message":...}}` to stderr instead.
 */

let jsonMode = false;

/**
 * Silence human output for the rest of this run when `on`; the command prints
 * JSON itself. Commands with --json call it on every run, so one run's choice
 * never carries into the next (tests run many in one process).
 */
export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

const plain = (): boolean =>
  process.env.JADE_PLAIN === "1" || (process.env.JADE_PLAIN !== "0" && !process.stdout.isTTY);

/** Whether a person is there to answer a prompt */
export const canPrompt = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const TAG_WIDTH = 5;

const write = (out: (s: string) => void, tag: string, msg: string) => {
  const [first, ...rest] = msg.split("\n");
  out(`${tag.padEnd(TAG_WIDTH)} ${first}`);
  for (const r of rest) out(`${" ".repeat(TAG_WIDTH + 1)}${r}`);
};
const line = (tag: string, msg: string) => write((s) => console.log(s), tag, msg);

export function intro(msg: string): void {
  if (jsonMode) return;
  if (plain()) console.log(msg);
  else clack.intro(msg);
}

export function outro(msg: string): void {
  if (jsonMode) return;
  if (plain()) line("done", msg);
  else clack.outro(msg);
}

/** A fatal message; the caller exits */
export function cancel(msg: string): void {
  if (jsonMode) console.error(JSON.stringify({ error: { message: msg } }));
  else if (plain()) write((s) => console.error(s), "error", msg);
  else clack.cancel(msg);
}

const say = (tag: string, fancy: (msg: string) => void) => (msg: string) => {
  if (jsonMode) return;
  if (plain()) line(tag, msg);
  else fancy(msg);
};

export const log = {
  success: say("ok", clack.log.success),
  info: say("info", clack.log.info),
  warn: say("warn", clack.log.warn),
  error: say("error", clack.log.error),
  step: say("-", clack.log.step),
  /** Untagged text, such as a listing */
  message: say("", (msg) => clack.log.message(msg)),
};

/** A spinner in a terminal; otherwise each step is printed once, when it starts */
export function spinner(): { start(msg: string): void; message(msg: string): void; stop(msg: string): void } {
  if (jsonMode) return { start() {}, message() {}, stop() {} };
  if (!plain()) return clack.spinner();
  return {
    start: (msg) => line("-", msg),
    message: (msg) => line("-", msg),
    stop: (msg) => line("-", msg),
  };
}
