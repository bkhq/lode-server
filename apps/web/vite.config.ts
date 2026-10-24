import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const APP_NAME = process.env.APP_NAME ?? "lode-server";
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME ?? "Lode Server";
// Vite reads VITE_-prefixed env at config-load time. Mirror APP_* into them
// so import.meta.env and index.html %VITE_*% substitution work uniformly.
process.env.VITE_APP_NAME = APP_NAME;
process.env.VITE_APP_DISPLAY_NAME = APP_DISPLAY_NAME;

// Mirror apps/api/src/config.ts: unset / empty means root ("/"); otherwise
// normalise to "/<x>/" (trailing slash required by Vite's `base`).
const trimmedBase = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "");
const base = trimmedBase ? `/${trimmedBase}/` : "/";

// Dev only. With a base path Vite answers "/" with a redirect to the base, so
// a home page at the origin root (HOME_PAGE=root, which the API serves
// in production) would never show. Serve the shell at "/" instead and let the
// SPA decide what to render, as the API does.
function homeAtOriginRoot(): Plugin {
  return {
    name: "home-at-origin-root",
    apply: "serve",
    configureServer(server) {
      if (process.env.HOME_PAGE !== "root" || base === "/")
        return;
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/")
          return next();
        const html = await server.transformIndexHtml("/", readFileSync(`${server.config.root}/index.html`, "utf-8"));
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    homeAtOriginRoot(),
    tailwindcss(),
    TanStackRouterVite({
      routesDirectory: "./src/app/routes",
      generatedRouteTree: "./src/app/routeTree.gen.ts",
    }),
    react(),
  ],
  base,
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 5000,
    host: "0.0.0.0",
    allowedHosts: true,
  },
  build: {
    // Split the initial entry bundle along vendor boundaries so each layer can
    // be cached independently across deploys (`react` and `@tanstack/*` rarely
    // change; the app code churns most). Reduces the main `index.*.js` chunk
    // from ~560 KB to ~150 KB and clears Vite's >500 KB warning. The function
    // form is used (instead of the static `{ react: [...] }` map) so it
    // catches deeply-nested transitive imports under each vendor without
    // having to enumerate every sub-package.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules"))
            return undefined;
          if (/node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id))
            return "vendor-react";
          if (/node_modules[\\/]@tanstack[\\/]/.test(id))
            return "vendor-tanstack";
          if (/node_modules[\\/](?:i18next|react-i18next)[\\/]/.test(id))
            return "vendor-i18n";
          if (/node_modules[\\/](?:@base-ui|lucide-react|sonner|class-variance-authority|tailwind-merge|clsx|tw-animate-css)[\\/]/.test(id))
            return "vendor-ui";
          return undefined;
        },
      },
    },
  },
});
