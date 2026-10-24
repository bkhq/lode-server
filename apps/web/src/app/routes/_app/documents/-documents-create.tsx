// Empty state and create form for the documents page right pane.

import type { DraftState } from "./-documents-shared";
import { FileText, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MarkdownEditor } from "@/shared/components/editor";
import { Button } from "@/shared/components/ui/button";
import { useCreateDocument } from "@/shared/lib/api/documents";
import { errorMessage } from "@/shared/lib/errors";
import { EMPTY_DRAFT } from "./-documents-shared";

export function EmptyState({ onCreate }: { readonly onCreate: () => void }) {
  const { t } = useTranslation("documents");
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <FileText className="mb-3 size-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{t("selectToView")}</p>
      <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t("create")}
      </Button>
    </div>
  );
}

export function CreateForm({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("documents");
  const createMutation = useCreateDocument();
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const handleSave = () => {
    if (!draft.title.trim()) {
      toast.error(t("field.titleRequired"));
      return;
    }
    createMutation.mutate(
      {
        title: draft.title.trim(),
        content: draft.content,
        tags: draft.tags,
        parentId: null,
      },
      {
        onSuccess: (doc) => { onCreated(doc.id); },
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  // Mirror the edit-mode layout in DocumentDetail: a 45px header bar
  // with the title input + Cancel / Create actions, and a full-height
  // immersive Markdown editor below. Tags / attachments / comments
  // become available after the doc is created (they need a docId).
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[45px] shrink-0 items-center gap-3 border-b border-border px-6">
        <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={draft.title}
          onChange={e => setDraft(prev => ({ ...prev, title: e.target.value }))}
          placeholder={t("untitledPlaceholder")}
          className="min-w-0 flex-1 truncate border-0 bg-transparent px-0 text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
          aria-label="Document title"
          autoFocus
        />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={createMutation.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={createMutation.isPending || !draft.title.trim()}
          >
            {t("createTitle")}
          </Button>
        </div>
      </div>

      <MarkdownEditor
        value={draft.content}
        onChange={next => setDraft(prev => ({ ...prev, content: next }))}
        placeholder={t("field.contentPlaceholder")}
        floatingToolbar
        className="mx-auto min-h-0 w-full max-w-[1100px] flex-1 rounded-none border-0 px-6 pt-2 pb-5"
      />
    </div>
  );
}
