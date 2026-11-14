import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const stubs = fileURLToPath(new URL("../../bench/stubs.ts", import.meta.url));

// The signed-in app against the fake Hermes (and the sign-in screen), in a plain browser, for screenshots of the UI.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@tauri-apps/api/webview": stubs } },
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: ["index.html", "signin.html"].map((page) => fileURLToPath(new URL(page, import.meta.url))) } },
  logLevel: "warn",
});
