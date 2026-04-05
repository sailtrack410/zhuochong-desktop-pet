import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: {
      allow: [resolve(currentDir, "../..")],
    },
  },
  build: {
    outDir: "dist/renderer",
  },
});
