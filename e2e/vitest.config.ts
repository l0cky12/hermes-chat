import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  // Vitest scans only the test files for dependencies to pre-bundle. The app frame's own imports, found later on a cold
  // cache, made Vite reload the page in the middle of the first test.
  optimizeDeps: { entries: ["e2e/app.html"] },
  test: {
    include: ["e2e/features/**/*.e2e.tsx"],
    testTimeout: 30_000,
    // A failing test's screenshot goes in failure-screenshots/ here. Vitest also copies it here under a hash, so this
    // isn't e2e/out/screenshots, which holds only the screenshots the tests name.
    attachmentsDir: "e2e/out/attachments",
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }], viewport: { width: 1440, height: 900 } },
  },
});
