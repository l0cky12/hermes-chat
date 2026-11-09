import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// While serving, React Refresh adds an inline script and Vite's reload talks over a WebSocket; index.html's CSP lets
// neither through, so it is loosened for the dev server only.
const devCsp: Plugin = {
  name: "dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws:"),
};

export default defineConfig({
  plugins: [react(), devCsp],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
});
