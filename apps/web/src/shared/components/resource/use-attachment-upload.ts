// Shared building block for the attachment upload UX. Wires up the
// hidden <input>'s ref, the limits query, the POST mutation, query
// invalidation, and the input.value reset on settle. Validation policy
// (all-or-nothing vs. partition-by-size) stays at the call site since
// callers disagree on how to surface "too large" / "limit reached".

import type { ResourceAttachment } from "./attachment-section";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { useUploadLimits } from "@/shared/hooks/use-upload-limits";
import { http } from "@/shared/lib/http";

import { attachmentsQueryKey } from "./attachment-section";

export function useResourceAttachmentUpload({
  resource,
  resourceId,
  onError,
}: {
  readonly resource: string;
  readonly resourceId: string;
  readonly onError?: (err: unknown) => void;
}) {
  const qc = useQueryClient();
  const limits = useUploadLimits();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reads the same query as ResourceAttachmentSection — TanStack
  // dedupes, so this is free when the section is mounted too.
  const attachmentsQuery = useQuery({
    queryKey: attachmentsQueryKey(resource, resourceId),
    queryFn: () => http<{ data: ResourceAttachment[] }>(`/${resource}/${resourceId}/attachments`).then(r => r.data),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        await http(`/${resource}/${resourceId}/attachments`, { method: "POST", body: fd });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: attachmentsQueryKey(resource, resourceId) });
    },
    onError: (err) => {
      onError?.(err);
    },
    onSettled: () => {
      if (fileInputRef.current)
        fileInputRef.current.value = "";
    },
  });

  return {
    upload,
    fileInputRef,
    limits,
    attachmentCount: attachmentsQuery.data?.length ?? 0,
    openFilePicker: () => fileInputRef.current?.click(),
  };
}
