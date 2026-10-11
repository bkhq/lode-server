/**
 * All-or-nothing pre-flight check for an attachment upload selection:
 * returns "limit" when adding the files would push the resource over
 * its quota, "size" when any individual file exceeds the per-file cap,
 * "ok" otherwise.
 */
export function validateAttachmentSelection(
  files: readonly File[],
  existingCount: number,
  maxFileSize: number,
  maxAttachments: number,
): "ok" | "limit" | "size" {
  const remainingSlots = maxAttachments - existingCount;

  if (remainingSlots <= 0 || files.length > remainingSlots) {
    return "limit";
  }

  for (const file of files) {
    if (file.size > maxFileSize) {
      return "size";
    }
  }

  return "ok";
}

/**
 * Splits a selection by the per-file size cap. Used by callers that
 * prefer to upload the accepted files and report which were skipped,
 * rather than aborting the whole batch.
 */
export function partitionBySize(
  files: readonly File[],
  maxFileSize: number,
): { readonly accepted: File[]; readonly rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    if (file.size > maxFileSize)
      rejected.push(file);
    else
      accepted.push(file);
  }
  return { accepted, rejected };
}
