// Read-only markdown renderer for the editor's `readOnly` path.
//
// We mount react-markdown + remark-gfm but wrap the output in
// `<div class="md-preview"><div class="ProseMirror">...</div></div>`.
// The inner `.ProseMirror` class is the same hook Milkdown uses for the
// editing surface, so every prose rule defined under
// `:is(.md-editor, .md-preview) .ProseMirror X` in `milkdown-editor.css`
// applies to both modes from a single source of truth. Height tracks
// the rendered content — no fixed min-height, no internal scroll.

import type { Components } from "react-markdown";

import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "@/shared/lib/utils";

import "./milkdown-editor.css";

// Allow CommonMark inline HTML (`<br>`, `<sub>`, `<sup>`, …) the same
// way Milkdown's commonmark preset does in the editor. Anything not on
// the safe-by-default rehype-sanitize schema is stripped — no <script>,
// no event handlers, no javascript: URLs.
const sanitizeSchema = {
  ...defaultSchema,
  // rehype-sanitize's default schema already permits `br`, but we list
  // the common formatting tags explicitly so they survive the sanitizer
  // when they appear in user markdown.
  tagNames: [...(defaultSchema.tagNames ?? []), "br", "sub", "sup", "kbd", "mark"],
};

interface MarkdownPreviewProps {
  readonly value: string;
  readonly className?: string | undefined;
}

// react-markdown emits `<input type="checkbox" disabled>` for GFM task
// list items. The Milkdown editor's node view assigns a `md-task-checkbox`
// class so the checkbox carries the same skin in both surfaces.
// A link in user markdown is untrusted, attacker-influenced content.
// `rel="ugc"` flags it as user-generated; `noopener noreferrer` severs
// the `window.opener` / Referer leak. External (absolute) links open in
// a new tab; relative/in-app links keep default same-tab navigation.
function isExternalHref(href: string | undefined): boolean {
  if (!href)
    return false;
  return /^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//");
}

const markdownComponents: Components = {
  a({ href, ...props }) {
    const external = isExternalHref(href);
    return (
      <a
        {...props}
        href={href}
        rel="noopener noreferrer ugc"
        {...(external ? { target: "_blank" } : {})}
      />
    );
  },
  input(props) {
    if (props.type === "checkbox") {
      return (
        <input
          {...props}
          className={cn("md-task-checkbox", props.className)}
          readOnly
        />
      );
    }
    return <input {...props} />;
  },
};

export function MarkdownPreview({ value, className }: MarkdownPreviewProps) {
  return (
    <div className={cn("md-preview", className)}>
      <div className="ProseMirror">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
          components={markdownComponents}
        >
          {value || ""}
        </Markdown>
      </div>
    </div>
  );
}

export default MarkdownPreview;
