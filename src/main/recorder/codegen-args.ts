/**
 * Build the argv for `npx playwright codegen`. Pure: no IO. Only allowlisted
 * flags — never interpolate option values into a shell (the caller passes the
 * result as an argv array), and every option is validated first.
 */

import type { RecorderStartOptions } from "../../shared/ipc-contract.js";
import { requireHttpUrl } from "../../shared/schema.js";
import { UnknownRecorderDeviceError } from "./errors.js";

/**
 * Build the argv tail for `npx playwright codegen` (everything after
 * `["playwright", "codegen"]`). Pure: no IO. Only allowlisted flags —
 * never interpolates option values into shell (caller passes the result
 * as an argv array). Throws on any invalid option, including device names
 * outside `knownDevices` (prod passes the real Playwright device table;
 * tests inject a small set).
 */
export function buildCodegenArgs(
  baseUrl: string,
  outputPath: string,
  options: RecorderStartOptions,
  knownDevices?: ReadonlySet<string>,
): string[] {
  // Codegen's first positional is the URL. Validate it as a URL here too:
  // a value starting with `-` would otherwise be parsed as a CLI option
  // (e.g. `--save-storage=<path>`), and non-http(s) schemes are not supported.
  if (baseUrl.trim() === "") {
    throw new Error("codegen URL is required — set the case URL or project base URL");
  }
  const args = [requireHttpUrl(baseUrl, "codegen URL"), "--output", outputPath];
  const viewport = options.viewport;
  if (viewport !== undefined) {
    const { width, height } = viewport;
    const valid =
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 100 &&
      width <= 7680 &&
      height >= 100 &&
      height <= 4320;
    if (!valid) {
      throw new Error(
        `invalid viewport ${String(width)}x${String(height)} — width/height must be 100..7680 / 100..4320`,
      );
    }
    args.push("--viewport-size", `${width},${height}`);
  }
  if (options.device !== undefined) {
    const device = options.device;
    if (device.startsWith("-") || device.includes("--") || !/^[A-Za-z0-9 _./()+-]+$/.test(device)) {
      throw new Error(`unsafe device name "${device}" — must not look like a CLI flag`);
    }
    if (knownDevices !== undefined && !knownDevices.has(device)) {
      throw new UnknownRecorderDeviceError(device);
    }
    args.push("--device", device);
  }
  if (options.colorScheme !== undefined) {
    const scheme: string = options.colorScheme;
    if (scheme !== "light" && scheme !== "dark") {
      throw new Error(`invalid colorScheme "${scheme}" — "light" | "dark"`);
    }
    args.push("--color-scheme", options.colorScheme);
  }
  if (options.locale !== undefined) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.locale)) {
      throw new Error(`invalid locale "${options.locale}" — BCP47-like, e.g. en-GB`);
    }
    args.push("--lang", options.locale);
  }
  if (options.timezone !== undefined) {
    if (
      options.timezone.startsWith("-") ||
      !/^(?!.*\.\.)[A-Za-z0-9_+/-]+$/.test(options.timezone)
    ) {
      throw new Error(`invalid timezone "${options.timezone}" — IANA-like, e.g. Europe/Rome`);
    }
    args.push("--timezone", options.timezone);
  }
  const storageFlags = [
    ["storageStatePath", "--load-storage"],
    ["saveStoragePath", "--save-storage"],
  ] as const;
  for (const [key, flag] of storageFlags) {
    const value = options[key];
    if (value !== undefined) {
      if (value === "" || value.startsWith("-") || value.includes("\0")) {
        throw new Error(`invalid ${key} — must be a path, not a CLI flag`);
      }
      args.push(flag, value);
    }
  }
  return args;
}
