import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { i18nReady } from "./app/i18n";
import { Providers } from "./app/providers";
import { routeTree } from "./app/routeTree.gen";
import { NotFoundPage } from "./shared/components/not-found";
import { isOriginRootPage } from "./shared/lib/home";
import "./index.css";

// With HOME_PAGE=root the home page is served at the origin root, outside
// BASE_PATH, so the router drops the prefix there; every other page keeps it.
const basepath = isOriginRootPage()
  ? "/"
  : import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";
const router = createRouter({
  routeTree,
  basepath,
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    titleKey?: string;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl)
  throw new Error("Root element #root not found");

// Wait for the active language's namespaces to load before the first React
// render. Without this gate, `useTranslation` would briefly return raw keys
// (`"auth.login"`) until the lazy locale chunks resolve — a visible flash
// even though each namespace is only a few KB. Resolves at microtask scale
// once the chunks are cached in the browser.
void i18nReady.then(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <Providers>
        <RouterProvider router={router} />
        {/* Sonner toaster — global notification surface. Picks up `dark`
            from the html class so it inherits the active theme. richColors
            gives info / success / warning / error the standard colours. */}
        <Toaster position="top-right" richColors closeButton />
      </Providers>
    </StrictMode>,
  );
});
