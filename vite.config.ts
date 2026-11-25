import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The Fastify API origin. Dev runs vite on 5175 and proxies /api to it,
// so the app is same-origin in dev and in the built single-server mode.
const API_ORIGIN = process.env.SN_API_ORIGIN ?? "http://127.0.0.1:8790";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@server": fileURLToPath(new URL("./server", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: false,
    proxy: {
      "/api": { target: API_ORIGIN, changeOrigin: false },
      "/media": { target: API_ORIGIN, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
