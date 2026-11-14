import { defineCommand } from "citty";
import { resolve } from "path";
import { cancel, log } from "@clack/prompts";
import { findWorkspaceRoot, getCurrentGroup, listWorktreeDirs } from "../core/layout.ts";
import { resolveGroup } from "../core/group.ts";
import { type FileSystemBackend, realFileSystemBackend } from "../adapters/fs-backend.ts";

interface ExecResult {
  exitCode: number;
  /** Combined stdout+stderr, only when captured */
  output?: string;
}

/**
 * Runs one command in one app directory. `capture` buffers output (used for
 * --parallel so apps don't interleave); otherwise output streams straight to
 * the terminal. Injected so tests never spawn processes.
 */
export type ExecRunner = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; capture: boolean }
) => Promise<ExecResult>;

const defaultExecRunner: ExecRunner = async (argv, { cwd, env, capture }) => {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      env: { ...process.env, ...env },
      stdin: capture ? "ignore" : "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
    });
    if (!capture) return { exitCode: await proc.exited };
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, output: stdout + stderr };
  } catch (error) {
    // e.g. command not found
    const message = `jade exec: ${error instanceof Error ? error.message : String(error)}\n`;
    if (!capture) process.stderr.write(message);
    return { exitCode: 127, output: message };
  }
};

/**
 * Split argv at the first `--`. Everything after it is the command; a single
 * argument containing whitespace is treated as a shell string (`"a && b"`).
 */
export function parseExecCommand(rawArgs: string[]): string[] | null {
  const sep = rawArgs.indexOf("--");
  if (sep === -1) return null;
  const command = rawArgs.slice(sep + 1);
  if (command.length === 0) return null;
  if (command.length === 1 && /\s/.test(command[0]!)) return ["sh", "-c", command[0]!];
  return command;
}

export function makeExecCommand(
  fs: FileSystemBackend = realFileSystemBackend,
  runner: ExecRunner = defaultExecRunner
) {
  return defineCommand({
    meta: {
      name: "exec",
      description:
        "Run a command in every app of a workspace group: jade exec [-g group] [--apps a,b] [--parallel] -- <command...>",
    },
    args: {
      group: {
        type: "string",
        alias: "g",
        description: "Worktree group to run in (defaults to the current group, or 'main')",
      },
      apps: {
        type: "string",
        description: "Comma-separated apps to run in (default: every app present in the group)",
      },
      parallel: {
        type: "boolean",
        alias: "p",
        description: "Run in all apps at once; each app's output is printed when it finishes",
        default: false,
      },
      workspace: {
        type: "string",
        alias: "w",
        description: "Workspace root path",
      },
    },
    async run({ args, rawArgs }) {
      const command = parseExecCommand(rawArgs ?? []);
      if (!command) {
        cancel(`Usage: jade exec [-g group] [--apps a,b] [--parallel] -- <command...>`);
        process.exit(1);
      }

      const workspaceRoot = args.workspace
        ? resolve(args.workspace as string)
        : await findWorkspaceRoot(process.cwd(), fs);

      if (!workspaceRoot) {
        cancel(`Not in a jade workspace. Run 'jade init' first.`);
        process.exit(1);
      }

      const groupName =
        (args.group as string | undefined) || getCurrentGroup(workspaceRoot, process.cwd()) || "main";
      const groups = await listWorktreeDirs(workspaceRoot, fs);
      if (!groups.includes(groupName)) {
        cancel(`Worktree group '${groupName}' not found. See 'jade workspace list'.`);
        process.exit(1);
      }

      const group = await resolveGroup(workspaceRoot, groupName, fs);
      let apps = group.apps.filter((a) => a.present);

      if (args.apps !== undefined) {
        const requested = (args.apps as string).split(",").map((a) => a.trim()).filter(Boolean);
        const missing = requested.filter((r) => !apps.some((a) => a.name === r));
        if (missing.length > 0) {
          cancel(
            `Not in '${groupName}': ${missing.join(", ")}. Present: ${apps.map((a) => a.name).join(", ") || "none"}`
          );
          process.exit(1);
        }
        apps = apps.filter((a) => requested.includes(a.name));
      }

      if (apps.length === 0) {
        cancel(`No apps in '${groupName}'.`);
        process.exit(1);
      }

      const parallel = args.parallel as boolean;
      const header = (name: string) => `\n── ${name} ──`;
      const envFor = (name: string) => ({ JADE_APP: name, JADE_GROUP: groupName, JADE_ROOT: workspaceRoot });
      const failed: { name: string; exitCode: number }[] = [];

      if (parallel) {
        await Promise.all(
          apps.map(async (app) => {
            const result = await runner(command, { cwd: app.path, env: envFor(app.name), capture: true });
            // Print as each finishes so fast apps aren't held behind slow ones.
            console.log(header(app.name));
            if (result.output) process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
            if (result.exitCode !== 0) failed.push({ name: app.name, exitCode: result.exitCode });
          })
        );
      } else {
        for (const app of apps) {
          console.log(header(app.name));
          const result = await runner(command, { cwd: app.path, env: envFor(app.name), capture: false });
          if (result.exitCode !== 0) failed.push({ name: app.name, exitCode: result.exitCode });
        }
      }

      console.log("");
      const ok = apps.length - failed.length;
      if (failed.length === 0) {
        log.success(`${ok}/${apps.length} succeeded in '${groupName}'`);
        return;
      }
      log.error(
        `${failed.length}/${apps.length} failed in '${groupName}': ` +
          failed.map((f) => `${f.name} (exit ${f.exitCode})`).join(", ")
      );
      process.exit(1);
    },
  });
}

export default makeExecCommand();
