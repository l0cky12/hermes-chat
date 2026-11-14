import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  test: {
    include: ["e2e/features/**/*.e2e.tsx"],
    testTimeout: 30_000,
    // A failing test's screenshot goes in failure-screenshots/ here. Vitest also copies it here under a hash, so this
    // isn't e2e/out/screenshots, which holds only the screenshots the tests name.
    attachmentsDir: "e2e/out/attachments",
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }], viewport: { width: 1440, height: 900 } },
  },
});
