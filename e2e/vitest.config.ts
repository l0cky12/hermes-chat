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
    // A failing test's screenshot goes under it, in failure-screenshots/.
    attachmentsDir: "e2e/out/screenshots",
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }], viewport: { width: 1440, height: 900 } },
  },
});
