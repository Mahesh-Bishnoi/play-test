import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

/**
 * better-sqlite3 ships Node-ABI prebuilds and its binding.gyp short-circuits
 * to `type: none` when one exists — so electron-rebuild (and Forge's
 * rebuild hook) silently produce no Electron binding. Compile it explicitly
 * against the installed Electron headers, skipping when a stamp shows the
 * binding is already built for this Electron version.
 */
async function ensureElectronSqliteBinding(projectDir: string): Promise<void> {
  const sqliteDir = join(projectDir, "node_modules", "better-sqlite3");
  const electronVersion: string = JSON.parse(
    readFileSync(join(projectDir, "node_modules", "electron", "package.json"), "utf8"),
  ).version;
  const binding = join(sqliteDir, "build", "Release", "better_sqlite3.node");
  const stamp = join(sqliteDir, "build", "electron-abi.stamp");
  if (existsSync(binding) && existsSync(stamp) && readFileSync(stamp, "utf8") === electronVersion) {
    return;
  }
  const nodeGyp = join(projectDir, "node_modules", ".bin", "node-gyp");
  await new Promise<void>((resolve, reject) => {
    execFile(
      nodeGyp,
      [
        "rebuild",
        "--release",
        "--force_build=1",
        "--runtime=electron",
        `--target=${electronVersion}`,
        "--disturl=https://electronjs.org/headers",
      ],
      { cwd: sqliteDir },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  writeFileSync(stamp, electronVersion);
}

const config: ForgeConfig = {
  packagerConfig: {
    // .node binaries cannot be dlopened from inside an asar archive.
    asar: { unpack: "**/*.node" },
    // The Vite plugin defaults to ignoring everything outside `/.vite`,
    // which drops node_modules — but vite.main.config.ts externalizes
    // native/dynamic packages (playwright, ...) that main.cjs requires
    // at runtime. Keep the built output plus the production node_modules
    // they resolve from (packager prunes devDependencies by default).
    ignore: (file) => {
      if (!file) return false;
      if (file.startsWith("/.vite")) return false;
      if (file === "/package.json") return false;
      if (file.startsWith("/node_modules")) return false;
      return true;
    },
  },
  rebuildConfig: {},
  hooks: {
    prePackage: async (_forgeConfig, _platform, _arch) => {
      await ensureElectronSqliteBinding(process.cwd());
    },
  },
  makers: [new MakerSquirrel({}), new MakerZIP({}), new MakerRpm({}), new MakerDeb({})],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.ts" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
