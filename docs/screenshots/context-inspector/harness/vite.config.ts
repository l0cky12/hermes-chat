import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const stubs = fileURLToPath(new URL("../../../../bench/stubs.ts", import.meta.url));

// The screenshot page: a production build of the real chat pane and status bar, Tauri stubbed as the bench does.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@tauri-apps/api/webview": stubs } },
  build: { outDir: "/tmp/h97-shots-dist", emptyOutDir: true },
  logLevel: "warn",
});
