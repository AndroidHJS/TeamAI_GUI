import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, "electron/main.ts") } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/preload.ts"),
        output: { format: "cjs", entryFileNames: "preload.js" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, "index.html") } },
  },
});
