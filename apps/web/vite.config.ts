import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vite";

const apiTarget = "http://127.0.0.1:3001";

function readAppApiKey(): string {
  try {
    const file = readFileSync(resolve(import.meta.dirname, "../../.env"), "utf8");
    const line = file.split("\n").find((entry) => entry.startsWith("APP_API_KEY="));
    return line?.slice("APP_API_KEY=".length).trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

function proxy(): ProxyOptions {
  const apiKey = readAppApiKey();
  return {
    target: apiTarget,
    changeOrigin: true,
    configure: (server) => {
      server.on("proxyReq", (proxyReq) => {
        if (apiKey) proxyReq.setHeader("X-API-Key", apiKey);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": proxy(),
      "/healthz": proxy(),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": proxy(),
      "/healthz": proxy(),
    },
  },
});
