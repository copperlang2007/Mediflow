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

// Demo builds (VITE_DEMO_MODE=true) swap the real Clerk SDK for inert local
// shims so the app renders the authenticated shell with a fixed seeded
// identity and no Clerk account. Production builds set no such flag and
// bundle the real "@clerk/*" packages untouched. Finds are EXACT regexes so
// they match only the bare module specifier — never a subpath like
// "@clerk/themes/shadcn.css" (imported by index.css) or "@clerk/react/internal".
const demoMode = process.env.VITE_DEMO_MODE === "true";
const demoClerkAlias = demoMode
  ? [
      { find: /^@clerk\/react\/internal$/, replacement: path.resolve(import.meta.dirname, "src/lib/demo/clerkInternalShim.ts") },
      { find: /^@clerk\/react$/, replacement: path.resolve(import.meta.dirname, "src/lib/demo/clerkReactShim.tsx") },
      { find: /^@clerk\/themes$/, replacement: path.resolve(import.meta.dirname, "src/lib/demo/clerkThemesShim.ts") },
    ]
  : [];

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
      ...demoClerkAlias,
      { find: "@assets", replacement: path.resolve(import.meta.dirname, "..", "..", "attached_assets") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
    ],
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Manual chunk-splitting: keep vendor bundles separate from app code
        // so that browser caching survives incremental app updates.
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-clerk": ["@clerk/react"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-charts": ["recharts"],
          "vendor-ui": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
          ],
          "vendor-router": ["wouter"],
          "vendor-utils": ["date-fns", "zod", "clsx", "tailwind-merge"],
        },
      },
    },
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
