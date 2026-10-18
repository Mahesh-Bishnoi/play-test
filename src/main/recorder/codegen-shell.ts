/**
 * The recorder's process shell: spawn `playwright codegen`, wait out a short
 * grace period so a dead process surfaces as an error, and parse the output
 * file into steps on `stop`. Nondeterminism (spawn/FS/time) is injected via
 * `RecorderDeps` so tests use fakes and prod uses `defaultDeps()`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices } from "playwright";

import type { RecorderStartOptions, RecorderUnsupported } from "../../shared/ipc-contract.js";
import type { TestStep } from "../../shared/step-types.js";
import type { PlaywrightCliChild } from "../playwright-cli.js";
import { resolvePlaywrightCli, spawnPlaywrightCli } from "../playwright-cli.js";
import { buildCodegenArgs } from "./codegen-args.js";
import { parseCodegenOutput } from "./codegen-output.js";
import {
  RecorderAlreadyRunningError,
  RecorderNotRunningError,
  RecorderStartError,
} from "./errors.js";

export interface ParsedRecording {
  steps: TestStep[];
  /** Codegen lines that matched no mapping — reported, never silently converted (M15). */
  unsupported: RecorderUnsupported[];
  /** Full codegen file content (empty when codegen wrote nothing). Kept for debugging. */
  raw: string;
}

/**
 * Minimal child handle the recorder manages: the shared `PlaywrightCliChild`
 * in prod, a fake in tests. `hasExited`/`stderrTail` back the start grace
 * period and `RecorderStartError` (M15 item 5).
 */
export type CodegenChild = PlaywrightCliChild;

export interface RecorderDeps {
  spawnCodegen: (
    outputPath: string,
    baseUrl: string,
    options: RecorderStartOptions,
  ) => CodegenChild;
  readOutput: (outputPath: string) => string | null;
  discardOutput: (outputPath: string) => void;
  makeOutputPath: () => string;
  /** Sleep, injectable so the start/stop grace periods are deterministic in tests. */
  waitMs?: (ms: number) => Promise<void>;
  /** Start grace period in ms (default {@link START_GRACE_PERIOD_MS}); 0 = check immediately. */
  startGracePeriodMs?: number;
  /** Stop grace period in ms (default {@link STOP_GRACE_PERIOD_MS}); 0 = no wait. */
  stopGracePeriodMs?: number;
}

/** How long codegen gets to prove it stayed alive before `start` resolves. */
export const START_GRACE_PERIOD_MS = 1500;

/**
 * How long a graceful SIGINT gets before the recorder falls back to SIGTERM.
 * Codegen saves `--save-storage` and flushes its output file in its SIGINT
 * handler, so this wait is what makes saved auth state and the last recorded
 * actions reach disk.
 */
export const STOP_GRACE_PERIOD_MS = 3000;

/** Poll interval while waiting for the codegen child to exit. */
const STOP_POLL_INTERVAL_MS = 50;

/** Bound on the captured codegen stderr tail (chars). */
const CODEGEN_STDERR_TAIL_LIMIT = 2000;

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fallback launcher for when `playwright/cli.js` cannot be resolved (M15
 * item 5): the previous `npx playwright codegen …` spawn wrapped in the
 * `PlaywrightCliChild` shape so callers stay uniform. stderr is piped so the
 * start grace period can surface a launch failure.
 */
function spawnNpxCodegen(args: string[]): CodegenChild {
  const child: ChildProcess = spawn("npx", ["playwright", "codegen", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: process.platform === "win32",
  });
  let exited = child.exitCode !== null || child.signalCode !== null;
  let stderr = "";
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (err) => {
    stderr = `${stderr}${err.message}`.slice(-CODEGEN_STDERR_TAIL_LIMIT);
    exited = true;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${String(chunk)}`.slice(-CODEGEN_STDERR_TAIL_LIMIT);
  });
  return {
    pid: child.pid,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
    hasExited: () => exited,
    stderrTail: () => stderr,
  };
}

function defaultDeps(): RecorderDeps {
  return {
    spawnCodegen: (outputPath, baseUrl, options) => {
      const tail = buildCodegenArgs(baseUrl, outputPath, options, new Set(Object.keys(devices)));
      const cli = resolvePlaywrightCli();
      if (cli !== null) {
        return spawnPlaywrightCli(cli, ["codegen", ...tail], {
          stderrTailLimit: CODEGEN_STDERR_TAIL_LIMIT,
        });
      }
      return spawnNpxCodegen(tail);
    },
    readOutput: (outputPath) => {
      try {
        return readFileSync(outputPath, "utf8");
      } catch {
        return null;
      }
    },
    discardOutput: (outputPath) => {
      try {
        unlinkSync(outputPath);
      } catch {
        // Best effort — a leftover tmp file is harmless.
      }
    },
    makeOutputPath: () => join(tmpdir(), `playtest-codegen-${randomUUID()}.js`),
    waitMs: defaultWaitMs,
    startGracePeriodMs: START_GRACE_PERIOD_MS,
  };
}

/**
 * Owns one external `playwright codegen` window (PLAN §7). Single active
 * session: `start` spawns, `stop` kills, parses the output file, and clears
 * the session. Nondeterminism (spawn/FS) is injected via `RecorderDeps` so
 * tests use fakes and prod uses `defaultDeps()`.
 */
export class CodegenRecorder {
  private readonly deps: RecorderDeps;
  private active: { pid: number; outputPath: string; child: CodegenChild } | null = null;

  constructor(deps: RecorderDeps = defaultDeps()) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  activePid(): number | null {
    return this.active?.pid ?? null;
  }

  /**
   * Spawn codegen and wait out a short grace period (M15 item 5): a bad argv
   * or a missing browser makes the child exit immediately, which surfaces as
   * `RecorderStartError(stderrTail)` instead of a silently dead window.
   */
  async start(baseUrl: string, options: RecorderStartOptions = {}): Promise<{ pid: number }> {
    if (this.active !== null) {
      throw new RecorderAlreadyRunningError();
    }
    const outputPath = this.deps.makeOutputPath();
    const child = this.deps.spawnCodegen(outputPath, baseUrl, options);
    if (child.pid === undefined) {
      throw new Error("failed to launch playwright codegen (no pid)");
    }
    const graceMs = this.deps.startGracePeriodMs ?? START_GRACE_PERIOD_MS;
    if (graceMs > 0) {
      await (this.deps.waitMs ?? defaultWaitMs)(graceMs);
    }
    if (child.hasExited()) {
      throw new RecorderStartError(child.stderrTail());
    }
    this.active = { pid: child.pid, outputPath, child };
    return { pid: child.pid };
  }

  /**
   * Stop codegen gracefully (M18). Codegen's SIGINT handler saves
   * `--save-storage` and flushes the output file; SIGTERM bypasses it. Wait
   * for that handler (bounded), then fall back to SIGTERM (Windows has no
   * POSIX SIGINT delivery).
   */
  async stop(): Promise<ParsedRecording> {
    const session = this.active;
    if (session === null) {
      throw new RecorderNotRunningError();
    }
    this.active = null;
    try {
      session.child.kill("SIGINT");
    } catch {
      // The user may have closed codegen manually — parse what was written.
    }
    await this.waitForExit(session.child);
    if (!session.child.hasExited()) {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // Already gone — parse what was written.
      }
    }
    const raw = this.deps.readOutput(session.outputPath) ?? "";
    this.deps.discardOutput(session.outputPath);
    const { steps, unsupported } = parseCodegenOutput(raw);
    return { steps, unsupported, raw };
  }

  /** Poll `hasExited` until the stop grace period expires. */
  private async waitForExit(child: CodegenChild): Promise<void> {
    const timeoutMs = this.deps.stopGracePeriodMs ?? STOP_GRACE_PERIOD_MS;
    const waitMs = this.deps.waitMs ?? defaultWaitMs;
    for (let waited = 0; waited < timeoutMs; waited += STOP_POLL_INTERVAL_MS) {
      if (child.hasExited()) {
        return;
      }
      await waitMs(STOP_POLL_INTERVAL_MS);
    }
  }
}

/** Shared process-wide recorder (one codegen window per app, PLAN §7). */
export const sharedRecorder = new CodegenRecorder();
