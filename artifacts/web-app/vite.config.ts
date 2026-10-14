import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import compression from "vite-plugin-compression2";

// Env-var policy:
// - `vite build` needs only `BASE_PATH` (used as the asset/`base` URL). Default
//   `"/"` if unset so any host can build the project without configuration.
// - `vite` (dev server) + `vite preview` need a `PORT`. Default `5173` (Vite's
//   own default) if unset; only validate when the value is bad. A workflow
//   that sets `PORT=8080` keeps working unchanged.
//
// The strict runtime guards live on the api-server side (`artifacts/api-server/src/index.ts`).
// The build config should NOT crash CI/preview deploys for an env var that's
// only relevant at serve time.

const basePath = process.env.BASE_PATH ?? "/";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;
if (rawPort !== undefined && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    {
      name: "classic-entry-script",
      transformIndexHtml: {
        order: "post" as const,
        handler(html: string) {
          return html.replace(
            '<script type="module" crossorigin src="/app.js"></script>',
            '<script defer src="/app.js"></script>',
          );
        },
      },
    },
    // Production: emit gzip + brotli compressed assets alongside originals.
    // The CDN / static host serves the pre-compressed files automatically.
    ...(process.env.NODE_ENV === "production"
      ? [
          compression({ algorithm: "gzip", exclude: [/\.(br)$/, /\.(gz)$/] }),
          compression({ algorithm: "brotliCompress", exclude: [/\.(br)$/, /\.(gz)$/] }),
        ]
      : []),
  ],
  resolve: {
    alias: [
      { find: "@assets", replacement: path.resolve(import.meta.dirname, "..", "..", "attached_assets") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
    ],
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    assetsDir: "static",
    // Serve one self-contained classic script at an uncached, stable URL.
    // This avoids module loading for browsers failing to fetch the entry.
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        format: "iife",
        inlineDynamicImports: true,
      },
    },
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,

  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
