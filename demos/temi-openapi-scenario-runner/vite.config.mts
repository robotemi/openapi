import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const demoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: demoRoot,
  base: "./",
  build: {
    outDir: resolve(demoRoot, "dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
