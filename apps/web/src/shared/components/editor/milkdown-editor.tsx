// Milkdown-based markdown editor.
//
// Storage stays markdown (the DB column is `TEXT` markdown — see
// docs/develop/operations.md and the FTS5 index). Milkdown is built on
// ProseMirror + remark; the editor's serialiser owns markdown I/O, so
// we just feed it a string via `defaultValueCtx` and subscribe to
// `listenerCtx.markdownUpdated` to get the next markdown back.
//
// Markdown shortcuts (`# ` → h1, `**foo**` → bold, ``` ``` → code block,
// `[ ] ` → task list) work as you type because they are wired into the
// commonmark / gfm presets via ProseMirror input rules.

import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import type { JSX } from "react";

import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history, redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  addColAfterCommand,
  addRowAfterCommand,
  deleteSelectedCellsCommand,
  gfm,
  insertTableCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { lift } from "@milkdown/kit/prose/commands";
import { callCommand, replaceAll } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import {
  Bold,
  CheckSquare,
  Code,
  Code2,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/lib/utils";

import "./milkdown-editor.css";

interface MilkdownMarkdownEditorProps {
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly minHeight?: number | undefined;
  // Render the toolbar as a centered floating tile (rounded card with
  // its own border) instead of the default full-width bar. Used by the
  // immersive doc-detail editor so the toolbar reads as a writing aid,
  // not a page-spanning header.
  readonly floatingToolbar?: boolean | undefined;
}

function ToolbarButton({
  icon,
  title,
  onClick,
  disabled,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </Button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />;
}

// Only http(s) and mailto links may be applied. This blocks
// `javascript:` / `data:` schemes that would otherwise become a stored
// XSS vector once the markdown is rendered back as an `<a href>`.
function isAllowedLinkUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value)
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  }
  catch {
    return false;
  }
}

// Toggle blockquote on the current selection.
//
// `wrapInBlockquoteCommand` from milkdown is built on ProseMirror's `wrapIn`,
// which always adds a new wrapper without checking whether the selection is
// already inside a blockquote — clicking twice stacks `> > foo`. We invert
// that: if the selection sits anywhere inside a blockquote, `lift` removes
// the wrapper; otherwise we fall through to the wrap command.
function toggleBlockquote(ctx: Ctx) {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "blockquote") {
      lift(state, view.dispatch);
      return;
    }
  }
  callCommand(wrapInBlockquoteCommand.key)(ctx);
}

// Toggle a task-list item on the current selection.
//
// Milkdown's GFM preset ships an *input rule* for `[ ] ` / `[x] ` but no
// imperative command — task-list state lives as a `checked` attr on the
// `list_item` node. So we walk up the selection looking for a list_item;
// if found, flip `checked` between `null` (plain list) and `false` (task);
// otherwise we first wrap the block into a bullet list, then toggle. Two
// transactions are fine here — callCommand dispatches synchronously, so the
// new list_item is already in `view.state` by the time we re-read it.
function toggleTaskList(ctx: Ctx) {
  const flipAtDepth = () => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { $from } = state.selection;
    let depth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        depth = d;
        break;
      }
    }
    if (depth < 0)
      return false;
    const node = $from.node(depth);
    const pos = $from.before(depth);
    const nextChecked = node.attrs.checked == null ? false : null;
    view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: nextChecked }));
    return true;
  };
  if (flipAtDepth())
    return;
  callCommand(wrapInBulletListCommand.key)(ctx);
  flipAtDepth();
}

// Node view for `list_item`. GFM's task-list extension only adds a
// `checked` attr (null = plain list item, true/false = task) and renders
// `<li data-checked="...">`. Without a node view there is no real
// `<input>`, so the checkbox is non-interactive. This view paints a real
// checkbox when `checked != null`, stops mousedown from blurring the
// editor selection, and dispatches a setNodeMarkup on change.
function createTaskListItemNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement("li");
  const contentDOM = document.createElement("div");
  contentDOM.className = "md-li-content";
  let checkbox: HTMLInputElement | null = null;

  const render = (n: ProseNode) => {
    dom.removeAttribute("data-item-type");
    dom.removeAttribute("data-checked");
    if (checkbox) {
      checkbox.remove();
      checkbox = null;
    }
    if (n.attrs.checked != null) {
      dom.setAttribute("data-item-type", "task");
      dom.setAttribute("data-checked", String(n.attrs.checked));
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!n.attrs.checked;
      cb.contentEditable = "false";
      cb.className = "md-task-checkbox";
      // Preserve the editor's selection — without this, clicking the
      // checkbox blurs the doc and steals focus, which feels wrong.
      cb.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      cb.addEventListener("change", (e) => {
        const pos = getPos();
        if (pos == null)
          return;
        const current = view.state.doc.nodeAt(pos);
        if (!current)
          return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {
          ...current.attrs,
          checked: (e.target as HTMLInputElement).checked,
        }));
      });
      dom.prepend(cb);
      checkbox = cb;
    }
  };

  render(node);
  dom.appendChild(contentDOM);

  return {
    dom,
    contentDOM,
    update(updated) {
      if (updated.type !== node.type)
        return false;
      render(updated);
      return true;
    },
    // The checkbox lives in `dom` but outside `contentDOM`; without this
    // ProseMirror would treat its attribute flips as foreign mutations
    // and try to re-render the node from scratch.
    ignoreMutation(mutation) {
      if (!(mutation.target instanceof Node))
        return false;
      return checkbox != null && checkbox.contains(mutation.target);
    },
  };
}

function Toolbar({
  compact,
  floating,
}: {
  readonly compact?: boolean | undefined;
  readonly floating?: boolean | undefined;
}) {
  const { t } = useTranslation("editor");
  const [loading, getInstance] = useInstance();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState(false);

  // Wrap callCommand so the button handlers stay one-liners and gracefully
  // no-op while the editor is still mounting.
  const run = (fn: (ctx: Ctx) => void) => {
    if (loading)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    editor.action(fn);
  };

  const openLinkDialog = () => {
    setLinkUrl("");
    setLinkError(false);
    setLinkOpen(true);
  };

  const submitLink = () => {
    if (!isAllowedLinkUrl(linkUrl)) {
      setLinkError(true);
      return;
    }
    run(callCommand(toggleLinkCommand.key, { href: linkUrl.trim(), title: "" }));
    setLinkOpen(false);
  };

  const iconCls = "size-3.5";

  return (
    <>
      <div
        role="toolbar"
        aria-label={t("toolbar", "Editor toolbar")}
        className={cn(
          "flex flex-wrap items-center gap-0.5 bg-muted/30 px-2 py-1",
          floating
            ? "my-2 max-w-full self-center rounded-md border"
            : "border-b",
        )}
      >
        <ToolbarButton
          icon={<Undo2 className={iconCls} />}
          title={t("undo", "Undo")}
          onClick={() => run(callCommand(undoCommand.key))}
        />
        <ToolbarButton
          icon={<Redo2 className={iconCls} />}
          title={t("redo", "Redo")}
          onClick={() => run(callCommand(redoCommand.key))}
        />
        {!compact && (
          <>
            <Divider />
            <ToolbarButton icon={<Heading1 className={iconCls} />} title={t("heading1", "Heading 1")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 1))} />
            <ToolbarButton icon={<Heading2 className={iconCls} />} title={t("heading2", "Heading 2")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 2))} />
            <ToolbarButton icon={<Heading3 className={iconCls} />} title={t("heading3", "Heading 3")} onClick={() => run(callCommand(wrapInHeadingCommand.key, 3))} />
          </>
        )}
        <Divider />
        <ToolbarButton
          icon={<Bold className={iconCls} />}
          title={t("bold")}
          onClick={() => run(callCommand(toggleStrongCommand.key))}
        />
        <ToolbarButton
          icon={<Italic className={iconCls} />}
          title={t("italic")}
          onClick={() => run(callCommand(toggleEmphasisCommand.key))}
        />
        {!compact && (
          <ToolbarButton
            icon={<Strikethrough className={iconCls} />}
            title={t("strikethrough")}
            onClick={() => run(callCommand(toggleStrikethroughCommand.key))}
          />
        )}
        <ToolbarButton
          icon={<Code className={iconCls} />}
          title={t("inlineCode")}
          onClick={() => run(callCommand(toggleInlineCodeCommand.key))}
        />
        <ToolbarButton
          icon={<LinkIcon className={iconCls} />}
          title={t("link")}
          onClick={openLinkDialog}
        />
        <Divider />
        <ToolbarButton
          icon={<List className={iconCls} />}
          title={t("bulletList")}
          onClick={() => run(callCommand(wrapInBulletListCommand.key))}
        />
        <ToolbarButton
          icon={<ListOrdered className={iconCls} />}
          title={t("orderedList")}
          onClick={() => run(callCommand(wrapInOrderedListCommand.key))}
        />
        {!compact && (
          <ToolbarButton
            icon={<CheckSquare className={iconCls} />}
            title={t("taskList")}
            onClick={() => run(toggleTaskList)}
          />
        )}
        {!compact && (
          <>
            <Divider />
            <ToolbarButton
              icon={<Quote className={iconCls} />}
              title={t("quote")}
              onClick={() => run(toggleBlockquote)}
            />
            <ToolbarButton
              icon={<Code2 className={iconCls} />}
              title={t("codeBlock")}
              onClick={() => run(callCommand(createCodeBlockCommand.key))}
            />
            <Divider />
            <ToolbarButton
              icon={<TableIcon className={iconCls} />}
              title={t("table")}
              onClick={() => run(callCommand(insertTableCommand.key))}
            />
            <ToolbarButton
              icon={<Rows3 className={iconCls} />}
              title={t("tableAddRow", "Add row")}
              onClick={() => run(callCommand(addRowAfterCommand.key))}
            />
            <ToolbarButton
              icon={<Columns3 className={iconCls} />}
              title={t("tableAddColumn", "Add column")}
              onClick={() => run(callCommand(addColAfterCommand.key))}
            />
            <ToolbarButton
              icon={<Trash2 className={iconCls} />}
              title={t("tableDelete", "Delete row/column")}
              onClick={() => run(callCommand(deleteSelectedCellsCommand.key))}
            />
            <ToolbarButton
              icon={<Minus className={iconCls} />}
              title={t("horizontalRule")}
              onClick={() => run(callCommand(insertHrCommand.key))}
            />
          </>
        )}
      </div>
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("linkDialogTitle")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitLink();
            }}
            className="space-y-2"
          >
            <Input
              type="url"
              autoFocus
              value={linkUrl}
              placeholder={t("linkDialogPlaceholder")}
              aria-label={t("linkPrompt")}
              aria-invalid={linkError || undefined}
              onChange={(e) => {
                setLinkUrl(e.target.value);
                if (linkError)
                  setLinkError(false);
              }}
            />
            {linkError && (
              <p className="text-xs text-destructive">{t("linkInvalidUrl")}</p>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                {t("cancel")}
              </DialogClose>
              <Button type="submit">{t("linkInsert")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Tracks emptiness for the placeholder overlay. Milkdown's listener fires
// `markdownUpdated` on every doc change so a single boolean is enough — we
// only care whether the serialised value collapses to "".
function EmptyTracker({ initial, setIsEmpty }: { readonly initial: string; readonly setIsEmpty: (v: boolean) => void }) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    if (loading)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
        setIsEmpty(md.trim() === "");
      });
    });
  }, [loading, getInstance, setIsEmpty]);

  // Seed the initial flag without waiting for the first listener tick.
  useEffect(() => {
    setIsEmpty(initial.trim() === "");
  }, [initial, setIsEmpty]);

  return null;
}

// Reflects external `value` changes back into the editor. The lastEmittedRef
// guard prevents the round-trip "I emitted X, parent set X back" from
// triggering a redundant `replaceAll` that would steal the user's cursor.
function ExternalValueSync({
  value,
  lastEmittedRef,
}: {
  readonly value: string;
  readonly lastEmittedRef: React.MutableRefObject<string>;
}) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    if (loading)
      return;
    if (value === lastEmittedRef.current)
      return;
    const editor = getInstance();
    if (!editor)
      return;
    lastEmittedRef.current = value;
    editor.action(replaceAll(value));
  }, [loading, getInstance, value, lastEmittedRef]);

  return null;
}

interface EditorBodyProps extends MilkdownMarkdownEditorProps {
  readonly initialValue: string;
  readonly lastEmittedRef: React.MutableRefObject<string>;
}

function EditorBody({
  initialValue,
  lastEmittedRef,
  value: controlledValue,
  onChange,
  compact = false,
  placeholder,
  minHeight,
  floatingToolbar = false,
}: EditorBodyProps) {
  const { t } = useTranslation("editor");
  const [isEmpty, setIsEmpty] = useState(initialValue.trim() === "");

  // Pin onChange in a ref so the editor factory (which runs once) always
  // sees the latest callback without re-creating the editor on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEditor(root =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialValue);
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          if (md === lastEmittedRef.current)
            return;
          lastEmittedRef.current = md;
          onChangeRef.current?.(md);
        });
        // Register an interactive node view for `list_item` so GFM task
        // list checkboxes (`- [ ]` / `- [x]`) are clickable. The default
        // gfm preset extends the schema with a `checked` attr but only
        // renders `<li data-checked="...">` — no real <input>, so users
        // can't toggle. The node view here paints a real checkbox and
        // dispatches a setNodeMarkup transaction on change.
        ctx.update(editorViewOptionsCtx, prev => ({
          ...prev,
          nodeViews: {
            ...(prev?.nodeViews ?? {}),
            list_item: createTaskListItemNodeView,
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      // Parses pasted text/HTML through Milkdown's serializer + parser
      // so pasted markdown (e.g. `# Title`, `- list`, `**bold**`) is
      // converted to rich nodes instead of staying as plain text.
      .use(clipboard));

  const effectiveMinHeight = minHeight ?? (compact ? 80 : 280);
  const placeholderText = placeholder ?? t("placeholder", "Start writing… Markdown shortcuts work as you type.");

  return (
    <>
      <Toolbar compact={compact} floating={floatingToolbar} />
      <div className="md-editor-shell" style={{ minHeight: effectiveMinHeight }}>
        <Milkdown />
        {isEmpty && <div className="md-editor-placeholder">{placeholderText}</div>}
      </div>
      <EmptyTracker initial={initialValue} setIsEmpty={setIsEmpty} />
      {controlledValue !== undefined && <ExternalValueSync value={controlledValue} lastEmittedRef={lastEmittedRef} />}
    </>
  );
}

export function MilkdownMarkdownEditor(props: MilkdownMarkdownEditorProps) {
  const initialValue = props.value ?? props.defaultValue ?? "";
  // Stable across re-renders: the editor seeds itself from `initialValue`
  // exactly once via `defaultValueCtx`; subsequent external updates are
  // handled by `ExternalValueSync`.
  const lastEmittedRef = useRef<string>(initialValue);

  return (
    <div className={cn("md-editor rounded-md border bg-background", props.className)}>
      <MilkdownProvider>
        <EditorBody {...props} initialValue={initialValue} lastEmittedRef={lastEmittedRef} />
      </MilkdownProvider>
    </div>
  );
}

export default MilkdownMarkdownEditor;
