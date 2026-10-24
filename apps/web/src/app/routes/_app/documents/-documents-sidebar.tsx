// Folder-style tree sidebar (parent-id backed) for the documents page.

import type { DocumentTreeNode } from "@/shared/lib/api/documents";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ancestorIds,
  buildTreeIndex,
  toggleId,
} from "@/shared/components/portal/document-tree.utils";
import { Button } from "@/shared/components/ui/button";
import { useCreateDocument } from "@/shared/lib/api/documents";
import { errorMessage } from "@/shared/lib/errors";
import { cn } from "@/shared/lib/utils";
import { SearchDialog } from "./-documents-search";

export function DocumentsSidebar({
  tree,
  loading,
  error,
  selectedId,
  onSelect,
  onCreate,
}: {
  readonly tree: readonly DocumentTreeNode[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  const { t } = useTranslation("documents");
  const createMutation = useCreateDocument();

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);

  const index = useMemo(() => buildTreeIndex(tree), [tree]);
  const roots = index.childrenOf.get("") ?? [];

  // Create a sub-document directly under the hovered row. Auto-expand
  // the parent and jump selection to the new doc so the user lands in
  // the edit form.
  const handleCreateChild = (parentId: string) => {
    createMutation.mutate(
      {
        title: t("untitledPlaceholder"),
        content: "",
        parentId,
      },
      {
        onSuccess: (doc) => {
          setExpanded((prev) => {
            if (prev.has(parentId))
              return prev;
            const next = new Set(prev);
            next.add(parentId);
            return next;
          });
          onSelect(doc.id);
        },
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  const toggle = useCallback((id: string) => {
    setExpanded(prev => toggleId(prev, id));
  }, []);

  // Picking a result in the search dialog auto-expands the chosen doc's
  // ancestor chain so the row stays visible inside the tree.
  const handleSearchSelect = (id: string) => {
    const ancestors = ancestorIds(index, id);
    if (ancestors.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const a of ancestors) {
          if (!next.has(a)) {
            next.add(a);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    onSelect(id);
    setSearchOpen(false);
  };

  // Outer chrome (width / bg-muted / border-r) is owned by the wrapper
  // in DocumentsPage so the same content works inside both the inline
  // desktop column and the mobile slide-in Sheet. `min-w-0` +
  // `overflow-hidden` keep the sidebar's content (deep tree rows, long
  // titles) from spilling out horizontally into the main column.
  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* Header — height matched to the app sidebar's logo block on the
          left: `collapsible="icon"` mode renders SidebarHeader with `p-1`
          (4px) around a `size-9` (36px) link plus a 1px separator —
          44 + 1 = 45 — so my border-b lands on the same Y as the
          separator under the shield. No `pt-*`; the title centers
          inside the fixed-height row. */}
      <div className="flex h-[45px] shrink-0 items-center gap-1 border-b border-border px-4">
        <h2 className="flex-1 truncate text-base font-semibold tracking-tight">{t("page.title")}</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setSearchOpen(true)}
          title={t("searchPlaceholder")}
        >
          <Search className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onCreate}
          title={t("create")}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        tree={tree}
        onSelect={handleSearchSelect}
      />

      {/* Tree */}
      {/* `overflow-x-hidden` clips deep-indented or super-long tree rows
          at the sidebar's right edge instead of letting them visually
          extend into the main column / past the viewport. The button
          truncate handles short titles; this is the safety net for
          extreme cases. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {loading
          ? <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t("common.loading")}</div>
          : error
            ? (
                <div className="px-4 py-4 text-xs text-destructive">
                  {error instanceof Error
                    ? error.message
                    : t("common.error.loadFailed")}
                </div>
              )
            : roots.length === 0
              ? <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t("noResults")}</div>
              : (
                  <ul role="tree" aria-label={t("page.title")}>
                    {roots.map(node => (
                      <TreeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        index={index}
                        expanded={expanded}
                        onToggle={toggle}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        onCreateChild={handleCreateChild}
                        createPending={createMutation.isPending}
                      />
                    ))}
                  </ul>
                )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  index,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  onCreateChild,
  createPending,
}: {
  readonly node: DocumentTreeNode;
  readonly depth: number;
  readonly index: ReturnType<typeof buildTreeIndex>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreateChild: (parentId: string) => void;
  readonly createPending: boolean;
}) {
  const { t } = useTranslation("documents");
  const children = index.childrenOf.get(node.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  // Top-level nodes that *have* children render with a folder icon — they
  // act as folders since the backend dropped the dedicated folder concept.
  // Everything else is a file.
  const isFolder = depth === 0 && hasChildren;
  const indent = 8 + depth * 14;

  // WCAG 2.1.1 — folders must be reachable and operable from the
  // keyboard. ArrowRight expands (or steps into) a collapsed folder;
  // ArrowLeft collapses an expanded one. The chevron is also a real
  // focusable button (no `tabIndex={-1}`) so Tab + Enter/Space work too.
  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (!hasChildren)
      return;
    if (e.key === "ArrowRight" && !isExpanded) {
      e.preventDefault();
      e.stopPropagation();
      onToggle(node.id);
    }
    else if (e.key === "ArrowLeft" && isExpanded) {
      e.preventDefault();
      e.stopPropagation();
      onToggle(node.id);
    }
  };

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      aria-level={depth + 1}
      onKeyDown={handleRowKeyDown}
    >
      <div
        className={cn(
          "group mx-1 flex items-center gap-1 rounded-md pr-1 text-xs transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
        )}
        style={{ paddingLeft: `${indent}px` }}
      >
        {hasChildren
          ? (
              <button
                type="button"
                onClick={() => onToggle(node.id)}
                className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={isExpanded
                  ? t("tree.collapse")
                  : t("tree.expand")}
              >
                {isExpanded
                  ? <ChevronDown className="size-3.5" />
                  : <ChevronRight className="size-3.5" />}
              </button>
            )
          : <span className="size-4 shrink-0" />}
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
        >
          {isFolder
            ? (isExpanded
                ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                : <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />)
            : <FileText className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
          <span className="flex-1 truncate">{node.title}</span>
        </button>
        {/* Hover-revealed "new child" affordance. No date / meta — the
            row stays minimal so the tree itself does the talking. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreateChild(node.id);
          }}
          disabled={createPending}
          title={t("tree.newChild")}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground group-hover:inline-flex disabled:opacity-60"
        >
          <Plus className="size-3" strokeWidth={2.25} />
        </button>
      </div>

      {hasChildren && isExpanded && (
        <ul role="group">
          {children.map(child => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              index={index}
              expanded={expanded}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              createPending={createPending}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
