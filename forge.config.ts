import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const codexPackage = `node_modules/@openai/codex-${process.platform}-${process.arch}`;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [codexPackage],
    executableName: "organizer-butler",
    name: "Organizer Butler",
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ format: "ULFO" }, ["darwin"]),
    new MakerSquirrel({ name: "organizer_butler" }, ["win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/desktop/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/desktop/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [
        { name: "main_window", config: "vite.renderer.config.ts" },
      ],
    }),
  ],
};

export default config;
