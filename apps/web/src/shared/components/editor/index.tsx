// Public entry for the project's markdown surface.
//
// Read-only paths render via `markdown-preview` (react-markdown wrapped
// in a `.ProseMirror` element so it shares the editor's CSS — same
// font, line height, spacing) so the surface tracks content height
// without an embedded scroll container. Editable paths mount the
// Milkdown-based WYSIWYG editor that round-trips markdown via its
// built-in remark serialiser. Both are React.lazy so the route-shell
// stays small for users that never open one.

import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";

const LazyMarkdownPreview = lazy(() => import("./markdown-preview"));
const LazyMilkdownEditor = lazy(() => import("./milkdown-editor"));

interface MarkdownEditorProps {
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly minHeight?: number | undefined;
  readonly floatingToolbar?: boolean | undefined;
}

function Fallback() {
  return <div className="text-sm text-muted-foreground">Loading editor…</div>;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  if (props.readOnly) {
    return (
      <Suspense fallback={<Fallback />}>
        <LazyMarkdownPreview value={props.value ?? props.defaultValue ?? ""} className={props.className} />
      </Suspense>
    );
  }
  const editorProps: ComponentProps<typeof LazyMilkdownEditor> = {
    value: props.value,
    defaultValue: props.defaultValue,
    onChange: props.onChange,
    compact: props.compact,
    className: props.className,
    placeholder: props.placeholder,
    minHeight: props.minHeight,
    floatingToolbar: props.floatingToolbar,
  };
  return (
    <Suspense fallback={<Fallback />}>
      <LazyMilkdownEditor {...editorProps} />
    </Suspense>
  );
}
