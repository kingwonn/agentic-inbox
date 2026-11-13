import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  server: {
    port: 4801,
    proxy: {
      "/api": { target: process.env.TC_API ?? "http://127.0.0.1:4800", changeOrigin: false },
    },
  },
});
