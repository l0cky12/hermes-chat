import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const stubs = fileURLToPath(new URL("./stubs.ts", import.meta.url));

// A production build, so React and the markdown pipeline run as they do in the packaged app.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@tauri-apps/api/webview": stubs } },
  build: { outDir: "dist", emptyOutDir: true },
  logLevel: "warn",
});
