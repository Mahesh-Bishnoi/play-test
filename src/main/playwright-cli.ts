import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Shared Playwright CLI launcher (M15 item 5). One place that resolves the
 * installed Playwright package's `cli.js` and spawns it through Electron's Node
 * (`ELECTRON_RUN_AS_NODE=1`) so no `npx` on PATH is required — used by the
 * trace viewer (detached) and the recorder (piped stderr tail).
 *
 * `resolvePlaywrightCli` / `spawnPlaywrightCli` are the public API (the
 * recorder and trace viewer code against them); `buildPlaywrightCliSpawn` is
 * the pure argv/env builder so tests assert the launch line without spawning.
 */

/** Default stderr tail cap (chars) — enough for the cause, not the log. */
export const DEFAULT_STDERR_TAIL_LIMIT = 2000;

export interface PlaywrightCliSpawnOptions {
  /** Detach the child (viewer); the child is `unref()`d so it outlives the app. */
  detached?: boolean;
  /** Bound on the captured stderr tail (default `DEFAULT_STDERR_TAIL_LIMIT`). */
  stderrTailLimit?: number;
}

/** Minimal handle over a spawned CLI child (real one in prod, none in tests). */
export interface PlaywrightCliChild {
  pid: number | undefined;
  kill(signal?: string): boolean;
  /** true once the process has exited (or failed to spawn). */
  hasExited(): boolean;
  /** stderr captured so far, tail-capped to the configured limit. */
  stderrTail(): string;
}

/** The pure spawn line: `process.execPath`, argv, and the Electron-as-Node env. */
export interface PlaywrightCliSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the absolute `playwright/cli.js` path from the same `node_modules`
 * the externalized `playwright` import resolves from. Playwright's `exports`
 * map deliberately does not expose `./cli.js`, so resolve the package root
 * (`playwright/package.json` is exported) and join the CLI next to it.
 * Returns null when the package or file is missing.
 */
export function resolvePlaywrightCli(): string | null {
  try {
    // `__filename` exists in the bundled CJS main; fall back to CWD for dev.
    const anchor = typeof __filename === "string" ? __filename : process.cwd();
    const packageJson = createRequire(anchor).resolve("playwright/package.json");
    const cliPath = join(dirname(packageJson), "cli.js");
    return existsSync(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}

/**
 * Pure argv/env builder. `recordVideo`-style launch options (detached,
 * stderr cap) do not affect the command line, so this stays argument-only —
 * `_opts` mirrors `spawnPlaywrightCli`'s signature for callers/tests.
 */
export function buildPlaywrightCliSpawn(
  cliPath: string,
  args: string[],
  _opts: PlaywrightCliSpawnOptions = {},
): PlaywrightCliSpawn {
  return {
    command: process.execPath,
    args: [cliPath, ...args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Spawn the Playwright CLI (`process.execPath <cliPath> …args`) with stdout
 * ignored and stderr piped into a bounded tail. Synchronous spawn failures
 * propagate; callers wrap them with their manual fallback.
 */
export function spawnPlaywrightCli(
  cliPath: string,
  args: string[],
  opts: PlaywrightCliSpawnOptions = {},
): PlaywrightCliChild {
  const { command, args: argv, env } = buildPlaywrightCliSpawn(cliPath, args, opts);
  const limit = opts.stderrTailLimit ?? DEFAULT_STDERR_TAIL_LIMIT;
  const detached = opts.detached ?? false;
  const child = spawn(command, argv, {
    env,
    detached,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  let exited = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
    if (stderr.length > limit) {
      stderr = stderr.slice(-limit);
    }
  });
  const markExited = (): void => {
    exited = true;
  };
  child.on("exit", markExited);
  child.on("close", markExited);
  child.on("error", (err) => {
    stderr += String(err.message);
    if (stderr.length > limit) {
      stderr = stderr.slice(-limit);
    }
    markExited();
  });
  if (detached) {
    child.unref();
  }

  return {
    pid: child.pid,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
    hasExited: () => exited,
    stderrTail: () => stderr,
  };
}
