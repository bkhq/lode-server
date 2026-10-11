// Bundled attachments + comments tail block that both issues and
// documents detail pages render under their main content. Reads the
// shared attachments query to hide the section header (and the section
// entirely) when there are no attachments yet; the comments section
// always renders.

import type { ResourceAttachment } from "./attachment-section";
import type { ResourceComment, ResourceUser } from "./comment-section";

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";

import { attachmentsQueryKey, ResourceAttachmentSection } from "./attachment-section";
import { ResourceCommentSection } from "./comment-section";

function SectionHeader({
  children,
  action,
}: {
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </h3>
      {action}
    </div>
  );
}

export function ResourceFooterSections({
  resource,
  resourceId,
  i18nNs,
  userMap,
  canDeleteAttachment,
  canDeleteComment,
  commentsLocked = false,
  commentsEnableReply = false,
  commentsHeaderAction,
  sectionSpacingClassName = "mt-6",
}: {
  readonly resource: string;
  readonly resourceId: string;
  readonly i18nNs: string;
  readonly userMap: Map<string, ResourceUser>;
  readonly canDeleteAttachment: (att: ResourceAttachment) => boolean;
  readonly canDeleteComment: (c: ResourceComment) => boolean;
  readonly commentsLocked?: boolean;
  readonly commentsEnableReply?: boolean;
  /** Rendered next to the comments section label (e.g. a lock toggle). */
  readonly commentsHeaderAction?: React.ReactNode;
  /** Tailwind class applied to each <section> (e.g. "mt-6" or "mt-4"). */
  readonly sectionSpacingClassName?: string;
}) {
  const { t } = useTranslation(i18nNs);

  // Reuses the same query key that ResourceAttachmentSection issues
  // internally; TanStack dedupes the fetch.
  const attachmentsQuery = useQuery({
    queryKey: attachmentsQueryKey(resource, resourceId),
    queryFn: () => http<{ data: ResourceAttachment[] }>(`/${resource}/${resourceId}/attachments`).then(r => r.data),
  });
  const hasAttachments = (attachmentsQuery.data ?? []).length > 0;

  return (
    <>
      {hasAttachments && (
        <section className={cn(sectionSpacingClassName)}>
          <SectionHeader>{t("attachments.title")}</SectionHeader>
          <ResourceAttachmentSection
            resource={resource}
            resourceId={resourceId}
            i18nNs={i18nNs}
            canDelete={canDeleteAttachment}
          />
        </section>
      )}

      <section className={cn(sectionSpacingClassName)}>
        <SectionHeader action={commentsHeaderAction}>{t("comments.title")}</SectionHeader>
        <ResourceCommentSection
          resource={resource}
          resourceId={resourceId}
          userMap={userMap}
          i18nNs={i18nNs}
          locked={commentsLocked}
          enableReply={commentsEnableReply}
          canDelete={canDeleteComment}
        />
      </section>
    </>
  );
}
