// Documents page — folder-style tree sidebar (parent-id backed) + a
// detail/edit/create pane.
//
// Layout: a secondary tree sidebar on the left (folder-like icons for
// top-level nodes with children, hover-add to create sub-docs, search
// dialog opened from a header icon) + a right pane that renders one of
// three modes — empty placeholder, create form, or detail view (which
// internally toggles between read-only render and an explicit
// edit-with-save). Selection is local state, not URL — there are no
// child routes under this path.

/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/shared/components/ui/sheet";
import { TooltipProvider } from "@/shared/components/ui/tooltip";
import { useDocumentTree } from "@/shared/lib/api/documents";
import { CreateForm, EmptyState } from "./-documents-create";
import { DocumentDetail } from "./-documents-detail";
import { DocumentsSidebar } from "./-documents-sidebar";

export const Route = createLazyFileRoute("/_app/documents")({
  component: DocumentsPage,
});

type Mode = { type: "empty" } | { type: "new" } | { type: "detail"; docId: string };

// Sidebar resize — width persists across reloads via localStorage. Bounds
// keep the column usable: too narrow and titles vanish, too wide and the
// main column collapses.
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;
const SIDEBAR_WIDTH_DEFAULT = 224;
const SIDEBAR_WIDTH_KEY = "documents.sidebarWidth";

function clampWidth(n: number) {
  if (!Number.isFinite(n))
    return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
}

function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined")
      return SIDEBAR_WIDTH_DEFAULT;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return clampWidth(raw
      ? Number.parseInt(raw, 10)
      : SIDEBAR_WIDTH_DEFAULT);
  });
  const setAndPersist = useCallback((next: number) => {
    const v = clampWidth(next);
    setWidth(v);
    // `localStorage.setItem` throws in Safari private mode / when storage
    // is disabled or full — persistence is best-effort, so swallow it and
    // keep the in-memory width.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(v));
      }
      catch {
        // no-op: width still applied for this session.
      }
    }
  }, []);
  return [width, setAndPersist] as const;
}

function DocumentsPage() {
  const { t } = useTranslation("documents");
  const treeQuery = useDocumentTree();
  const tree = useMemo(() => treeQuery.data ?? [], [treeQuery.data]);
  const [mode, setMode] = useState<Mode>({ type: "empty" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();

  // Drag handle attached to the right edge of the desktop sidebar. Tracks
  // the starting pointer x + initial width so the new width follows the
  // delta exactly. document-level listeners pick up drags that wander
  // outside the 4px handle strip.
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (mv: MouseEvent) => setSidebarWidth(startWidth + (mv.clientX - startX));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth, setSidebarWidth]);

  // When a doc gets deleted (or selection becomes invalid for any other
  // reason), drop the mode back to empty so the right pane doesn't render
  // against a stale id.
  useEffect(() => {
    if (mode.type !== "detail")
      return;
    if (treeQuery.isLoading)
      return;
    if (!tree.some(n => n.id === mode.docId))
      // eslint-disable-next-line react/set-state-in-effect -- recover from external deletion.
      setMode({ type: "empty" });
  }, [mode, tree, treeQuery.isLoading]);

  // Selecting a doc / starting a new one on mobile also collapses the
  // sidebar sheet so the main pane becomes visible.
  const selectDoc = (id: string) => {
    setMode({ type: "detail", docId: id });
    setSidebarOpen(false);
  };
  const startCreate = () => {
    setMode({ type: "new" });
    setSidebarOpen(false);
  };

  const sidebarProps = {
    tree,
    loading: treeQuery.isLoading,
    error: treeQuery.error,
    selectedId: mode.type === "detail"
      ? mode.docId
      : null,
    onSelect: selectDoc,
    onCreate: startCreate,
  } as const;

  return (
    // delay=50ms keeps icon-action tooltips snappy compared to native
    // `title` (which has a ~700ms+ browser delay). Scoped to this page
    // so other routes are unaffected.
    <TooltipProvider delay={50}>
      {/* `overflow-hidden` here is the final clip — without it, a long
          word / inline-code / pre that escapes its column would bubble
          horizontal scroll up to the route-level `<main>` which has
          `overflow-auto`. `min-w-0` lets this container shrink inside
          the route flex column for the same reason. */}
      <div className="relative -mx-4 -my-3 flex h-[calc(100svh-3rem-1px)] min-w-0 flex-col overflow-hidden md:-mx-6 md:-my-4 md:h-svh md:flex-row">
        {/* Desktop sidebar — inline column at md+. `overflow-hidden`
          guarantees the (resizable-width) sidebar never lets its content
          visually escape into the main column or past the viewport, no
          matter how deep the tree nests or how long a title is.
          Width is inline-styled from localStorage-backed state so the
          drag handle below can update it live. */}
        <aside
          style={{ width: sidebarWidth }}
          className="hidden md:flex md:shrink-0 md:flex-col md:overflow-hidden md:border-r md:border-border md:bg-muted/30"
        >
          <DocumentsSidebar {...sidebarProps} />
        </aside>
        {/* Drag handle — overlays the sidebar/main boundary as a 4px
          transparent click target (2px on each side of aside's border-r).
          Lives outside the flex flow via absolute positioning so the
          main column sits flush against aside; the visible boundary
          stays the 1px `border-r`, with no break that would invite
          extending lines across it. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("page.title")}
          onMouseDown={startSidebarResize}
          style={{ left: `${sidebarWidth - 2}px` }}
          className="absolute inset-y-0 z-20 hidden w-1 cursor-col-resize bg-transparent transition-colors hover:bg-border md:block md:active:bg-border"
        />

        {/* Mobile sidebar — slide-in Sheet from the left, triggered by
          the menu button in the main sub-header below. */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="flex w-[85vw] max-w-sm flex-col gap-0 bg-background p-0">
            <SheetTitle className="sr-only">{t("page.title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("page.description")}</SheetDescription>
            <DocumentsSidebar {...sidebarProps} />
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Mobile-only sub-header with sidebar toggle — md+ has the
            sidebar always visible so no toggle needed. */}
          <div className="flex h-[45px] shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(true)}
              title={t("page.title")}
            >
              <Menu className="size-4" />
            </Button>
            <span className="truncate text-sm font-semibold tracking-tight">
              {t("page.title")}
            </span>
          </div>

          {/* `overflow-hidden` (instead of `md:overflow-visible`)
              closes the final crack — without it, a child whose own
              `overflow` lets content spill (a long inline `<code>` in a
              `<p>` for example) can extend the column visually past the
              sidebar's right edge. Each child here already manages its
              own scroll: view-mode body has `overflow-y-auto`, the
              editor's `.md-editor-shell` scrolls internally. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {mode.type === "empty" && <EmptyState onCreate={startCreate} />}
            {mode.type === "new" && (
              <CreateForm
                onCancel={() => setMode({ type: "empty" })}
                onCreated={id => setMode({ type: "detail", docId: id })}
              />
            )}
            {mode.type === "detail" && (
              <DocumentDetail
                key={mode.docId}
                docId={mode.docId}
                onDeleted={() => setMode({ type: "empty" })}
              />
            )}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
