// Documents data layer: types, raw clients, and TanStack Query hooks.
//
// 409 (VERSION_CONFLICT) is a load-bearing case for the immersive editor —
// the API returns the current row in `body.data` so the caller can rebase
// without losing the user's in-flight edits. The shared `http()` discards
// that payload, so the patch helper here uses `httpRaw()` and parses the
// envelope itself to surface the conflict row via `DocumentVersionConflictError`.

import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { HttpError, httpRaw } from "../http";

// ── Types ──

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly content: string | null;
  readonly tags: string;
  readonly parentId: string | null;
  readonly version: number;
  /**
   * When true, new comments are rejected by the API (admin/creator
   * bypass). Existing comments stay visible.
   */
  readonly commentsLocked: boolean;
  readonly creatorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentTreeNode {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly updatedAt: string;
  readonly childCount: number;
}

export interface SimpleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

export interface SimpleGroup {
  readonly id: string;
  readonly name: string;
}

export interface DocumentShare {
  readonly id: string;
  readonly documentId: string;
  readonly targetType: "user" | "group";
  readonly targetId: string;
  readonly permission: "viewer" | "editor";
  readonly createdAt: string;
  // null when the share is on this document directly; otherwise the
  // ancestor document this grant is inherited from. Inherited shares
  // cannot be removed from the current doc's share dialog — the user
  // must go to the source document instead.
  readonly inheritedFrom: { readonly id: string; readonly title: string } | null;
}

export interface Attachment {
  readonly id: string;
  readonly documentId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

// ── Helpers ──

export function parseTags(tagsJson: string | null | undefined): string[] {
  if (!tagsJson)
    return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed)
      ? parsed
      : [];
  }
  catch {
    return [];
  }
}

// ── Raw clients ──

interface ApiEnvelope<T> {
  readonly success: boolean;
  readonly data: T;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly meta?: { readonly total: number; readonly page: number; readonly limit: number };
}

/**
 * Documents needs the full envelope (`success` + `data` + `meta`) for
 * a couple of routes — `http()` strips it down to `data`. Build it on
 * top of `httpRaw()` so CSRF / credentials / event emission stay
 * consistent with the rest of the SPA.
 */
async function rawJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await httpRaw(path, init);
  return (await res.json()) as T;
}

/**
 * Thrown by {@link patchDocument} when the server reports VERSION_CONFLICT (409).
 * `.current` is the freshly-read row the caller should rebase on.
 */
export class DocumentVersionConflictError extends Error {
  readonly current: Document;
  constructor(current: Document) {
    super("Document version conflict");
    this.name = "DocumentVersionConflictError";
    this.current = current;
  }
}

interface UpdatePayload {
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
  readonly commentsLocked?: boolean;
  readonly version: number;
}

export async function patchDocument(id: string, payload: UpdatePayload): Promise<Document> {
  // VERSION_CONFLICT is the one error path that needs the full envelope:
  // the API embeds the freshly-read row in `body.data` so the editor can
  // rebase. `httpRaw` throws HttpError for other 4xx/5xx; we intercept
  // the 409 case, parse the envelope, and re-throw the typed conflict
  // error before the generic throw fires.
  try {
    const res = await httpRaw(`/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    const body = await res.json() as ApiEnvelope<Document>;
    return body.data;
  }
  catch (err) {
    if (err instanceof HttpError && err.status === 409 && err.code === "VERSION_CONFLICT") {
      // Refetch the current row so the editor can rebase. We discarded
      // the envelope inside httpRaw; one extra GET keeps the error
      // surface narrow and avoids special-casing httpRaw.
      const current = await rawJson<ApiEnvelope<Document>>(`/documents/${id}`);
      throw new DocumentVersionConflictError(current.data);
    }
    throw err;
  }
}

// ── Query keys ──

export const documentsKeys = {
  all: ["documents"] as const,
  tree: () => ["documents", "tree"] as const,
  detail: (id: string) => ["documents", "detail", id] as const,
  tags: () => ["documents", "tags"] as const,
  users: () => ["documents", "users"] as const,
  groups: () => ["documents", "groups"] as const,
  shares: (id: string) => ["documents", id, "shares"] as const,
  attachments: (id: string) => ["documents", id, "attachments"] as const,
  comments: (id: string) => ["documents", id, "comments"] as const,
};

// ── Query hooks ──

export function useDocumentTree() {
  return useQuery({
    queryKey: documentsKeys.tree(),
    queryFn: () => rawJson<ApiEnvelope<readonly DocumentTreeNode[]>>("/documents/tree").then(r => r.data),
    staleTime: 5_000,
  });
}

export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: documentsKeys.detail(id ?? ""),
    queryFn: () => rawJson<ApiEnvelope<Document>>(`/documents/${id}`).then(r => r.data),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useDocumentTags() {
  return useQuery({
    queryKey: documentsKeys.tags(),
    queryFn: () => rawJson<ApiEnvelope<readonly string[]>>("/documents/tags").then(r => r.data),
    staleTime: 30_000,
  });
}

export function useDocumentUsers() {
  return useQuery({
    queryKey: documentsKeys.users(),
    queryFn: () => rawJson<ApiEnvelope<readonly SimpleUser[]>>("/documents/users").then(r => r.data),
    staleTime: 60_000,
  });
}

export function useDocumentGroups() {
  return useQuery({
    queryKey: documentsKeys.groups(),
    queryFn: () => rawJson<ApiEnvelope<readonly SimpleGroup[]>>("/documents/groups").then(r => r.data),
    staleTime: 60_000,
  });
}

// ── Mutation hooks ──

interface CreateDocumentInput {
  readonly title: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
}

export function useCreateDocument(): UseMutationResult<Document, Error, CreateDocumentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDocumentInput) => {
      const res = await rawJson<ApiEnvelope<Document>>("/documents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: documentsKeys.tree(),
      });
    },
  });
}

export interface UpdateDocumentInput {
  readonly id: string;
  readonly version: number;
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
  readonly commentsLocked?: boolean;
}

/**
 * Optimistic update with rollback on failure. On 409 we restore the
 * pre-mutation snapshot rather than installing the server row: reseeding
 * the cache would bump `version` and make the detail view discard the
 * user's unsaved draft. The typed {@link DocumentVersionConflictError}
 * still propagates so the caller can warn the user and preserve the draft.
 */
export function useUpdateDocument(): UseMutationResult<Document, Error, UpdateDocumentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...payload }: UpdateDocumentInput) => {
      return patchDocument(id, payload);
    },
    onMutate: async (input) => {
      await qc.cancelQueries({
        queryKey: documentsKeys.detail(input.id),
      });
      const previous = qc.getQueryData<Document>(documentsKeys.detail(input.id));
      if (previous) {
        qc.setQueryData<Document>(documentsKeys.detail(input.id), {
          ...previous,
          ...(input.title !== undefined
            ? { title: input.title }
            : {}),
          ...(input.content !== undefined
            ? { content: input.content }
            : {}),
          ...(input.tags !== undefined
            ? {
                tags: JSON.stringify(input.tags),
              }
            : {}),
          ...(input.parentId !== undefined
            ? { parentId: input.parentId }
            : {}),
          ...(input.commentsLocked !== undefined
            ? { commentsLocked: input.commentsLocked }
            : {}),
        });
      }
      return { previous };
    },
    onError: (_err, input, ctx) => {
      // Always restore the pre-mutation snapshot — including on
      // VERSION_CONFLICT. Installing the server row here would change
      // `version` and trigger the detail view to reseed its draft,
      // silently discarding the user's unsaved edits. The component's
      // onError surfaces the conflict and keeps the draft instead.
      if (ctx?.previous) {
        qc.setQueryData(documentsKeys.detail(input.id), ctx.previous);
      }
    },
    onSuccess: (doc) => {
      qc.setQueryData(documentsKeys.detail(doc.id), doc);
      void qc.invalidateQueries({
        queryKey: documentsKeys.tree(),
      });
      void qc.invalidateQueries({
        queryKey: documentsKeys.tags(),
      });
    },
  });
}

export function useDeleteDocument(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await rawJson<ApiEnvelope<null>>(`/documents/${id}`, { method: "DELETE" });
    },
    onSuccess: (_, id) => {
      qc.removeQueries({
        queryKey: documentsKeys.detail(id),
      });
      void qc.invalidateQueries({
        queryKey: documentsKeys.tree(),
      });
    },
  });
}

export function useMoveDocument(): UseMutationResult<Document, Error, { readonly id: string; readonly parentId: string | null; readonly version: number }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, parentId, version }) => {
      const res = await rawJson<ApiEnvelope<Document>>(`/documents/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ parentId, version }),
      });
      return res.data;
    },
    onSuccess: (doc) => {
      qc.setQueryData(documentsKeys.detail(doc.id), doc);
      void qc.invalidateQueries({
        queryKey: documentsKeys.tree(),
      });
    },
  });
}
