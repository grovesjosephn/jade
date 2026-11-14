/**
 * herdr-core: persistent terminals that programs and agents run in, driven
 * through its `hc` CLI. Not to be confused with herdr-tui (the `herdr` CLI,
 * adapters/herdr-tui.ts), the multiplexer that lays out tabs and panes.
 *
 * Every call passes `--json`. herdr-core prints results on stdout, and failures as
 * `{error: {kind, message, hint}}` on stderr with a non-zero exit code; the
 * client turns those into an HerdrCoreError carrying `kind` (e.g. "not_found",
 * "name_taken") so callers can branch on it.
 */

export interface HerdrCoreResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one `hc` invocation. Injected so tests can fake herdr-core; never throws on a non-zero exit. */
export type HerdrCoreRunner = (args: string[]) => Promise<HerdrCoreResult>;

export const defaultRunHerdrCore: HerdrCoreRunner = async (args) => {
  const bin = process.env.HERDR_CORE_BIN_PATH || "hc";
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** True when this process runs inside a herdr-core terminal (herdr-core sets `HC_TERMINAL_ID` to its address). */
export function inHerdrCore(): boolean {
  return Boolean(process.env.HC_TERMINAL_ID);
}

export class HerdrCoreError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly hint: string | null,
    readonly exitCode: number
  ) {
    super(message);
    this.name = "HerdrCoreError";
  }
}

/** Agent status from the program's own reports; plain programs report none (null). */
export type HerdrCoreStatus = "idle" | "working" | "done" | "blocked" | "error";

export interface HerdrCoreTerminal {
  /** `t7`, or `machine/t7` for another machine. Stable for the terminal's life. */
  address: string;
  name: string | null;
  cwd: string;
  state: "live" | "finished";
  status: HerdrCoreStatus | null;
  /** What herdr-core detected running in it, e.g. "claude-code" or "fish". Only from `list`. */
  agent: string | null;
  /** Only from `get` and `start`; `list` doesn't include labels. */
  labels: Record<string, string>;
  exitCode: number | null;
}

export interface HerdrCoreWaitResult {
  /** True when the wait's condition was met (it stopped working, exited, or printed the text); false on timeout. */
  ended: boolean;
  reason: string | null;
  exitCode: number | null;
  status: HerdrCoreStatus | null;
}

export interface HerdrCoreStartOptions {
  /** Unique among live terminals: 1-32 of a-z 0-9 - _. */
  name?: string;
  cwd?: string;
  labels?: Record<string, string>;
  /** Keep running after the terminal that started it ends (herdr-core ends children with their parent by default). */
  outliveParent?: boolean;
}

function toTerminal(raw: any): HerdrCoreTerminal {
  return {
    address: String(raw.address),
    name: raw.name ?? null,
    cwd: raw.cwd ?? "",
    state: raw.state === "finished" ? "finished" : "live",
    status: raw.status ?? null,
    agent: raw.agent ?? null,
    labels: raw.labels ?? {},
    exitCode: raw.exit_code ?? null,
  };
}

export function makeHerdrCoreClient(run: HerdrCoreRunner = defaultRunHerdrCore) {
  async function call(args: string[]): Promise<any> {
    // Right after the subcommand: anything after `--` belongs to the program being started.
    const result = await run([args[0]!, "--json", ...args.slice(1)]);
    if (result.code !== 0) {
      let err: { kind?: string; message?: string; hint?: string } | undefined;
      try {
        err = JSON.parse(result.stderr)?.error;
      } catch {}
      throw new HerdrCoreError(
        err?.kind ?? "unknown",
        err?.message ?? (result.stderr.trim() || `hc ${args[0]} exited with code ${result.code}`),
        err?.hint ?? null,
        result.code
      );
    }
    return JSON.parse(result.stdout);
  }

  /** null when no terminal has that address or name. */
  async function get(terminal: string): Promise<HerdrCoreTerminal | null> {
    try {
      return toTerminal(await call(["get", terminal]));
    } catch (error) {
      if (error instanceof HerdrCoreError && error.kind === "not_found") return null;
      throw error;
    }
  }

  return {
    /** Live terminals (all of this user's, not just ours); `all` adds finished ones. */
    async list(opts: { all?: boolean } = {}): Promise<HerdrCoreTerminal[]> {
      const out = await call(["ls", ...(opts.all ? ["--all"] : [])]);
      return (out.terminals ?? []).map(toTerminal);
    },

    get,

    /** Start `argv` in the background (`hc run --bg`) and return the new terminal. */
    async start(argv: string[], opts: HerdrCoreStartOptions = {}): Promise<HerdrCoreTerminal> {
      const args = ["run", "--bg"];
      if (opts.name) args.push("--name", opts.name);
      if (opts.cwd) args.push("--cwd", opts.cwd);
      for (const [k, v] of Object.entries(opts.labels ?? {})) args.push("--label", `${k}=${v}`);
      if (opts.outliveParent) args.push("--outlive-parent");
      const started = toTerminal(await call([...args, "--", ...argv]));
      return { ...started, labels: opts.labels ?? {} };
    },

    /** Paste text and press Enter. */
    async send(terminal: string, text: string): Promise<void> {
      await call(["send", terminal, text]);
    },

    /** The screen, plus `lines` lines of history above it. */
    async read(terminal: string, opts: { lines?: number } = {}): Promise<string> {
      const out = await call(["read", terminal, ...(opts.lines ? ["--lines", String(opts.lines)] : [])]);
      return out.text ?? "";
    },

    /**
     * Wait until the terminal stops working or exits, or with `output`, until
     * it prints that text (only output printed after the wait starts counts).
     * A timeout isn't an error: it returns with `reason: "timeout"`.
     */
    async wait(terminal: string, opts: { output?: string; timeoutSec?: number } = {}): Promise<HerdrCoreWaitResult> {
      const args = ["wait", terminal];
      if (opts.output) args.push("--output", opts.output);
      if (opts.timeoutSec) args.push("--timeout", String(opts.timeoutSec));
      const out = await call(args);
      return {
        ended: Boolean(out.ended),
        reason: out.reason ?? null,
        exitCode: out.exit_code ?? null,
        status: out.status ?? null,
      };
    },

    /** End the terminal's program. It stays listed as finished until `remove`. */
    async kill(terminal: string): Promise<void> {
      await call(["kill", terminal]);
    },

    /** Remove a finished terminal. */
    async remove(terminal: string): Promise<void> {
      await call(["rm", terminal]);
    },
  };
}

export type HerdrCoreClient = ReturnType<typeof makeHerdrCoreClient>;
