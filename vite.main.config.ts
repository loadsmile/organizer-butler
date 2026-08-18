import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/desktop/main.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: [
        /^node:/,
        "electron",
      ],
    },
  },
});
