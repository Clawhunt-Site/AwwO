import type { IssueAttachment } from "@paperclipai/shared";
import { resolveContentUrl } from "../api/client";
import { isVideoContentType } from "./issue-output";

const GENERIC_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

type AttachmentPathLike = {
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
};

function normalizedContentType(attachment: Pick<IssueAttachment, "contentType">) {
  return attachment.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function attachmentFilename(attachment: Pick<IssueAttachment, "id" | "originalFilename">) {
  return attachment.originalFilename ?? attachment.id;
}

export function attachmentOpenPath(attachment: AttachmentPathLike) {
  // resolveContentUrl makes the server-emitted "/api/..." path embedding-aware
  // (no-op standalone) so EVERY caller is covered at the single source.
  return resolveContentUrl(attachment.openPath ?? attachment.contentPath);
}

export function attachmentDownloadPath(attachment: AttachmentPathLike) {
  return resolveContentUrl(attachment.downloadPath ?? `${attachment.contentPath}?download=1`);
}

/**
 * Find the index of the image attachment whose content matches a clicked markdown-image
 * `src`, so the caller can open the attachment gallery (else -1 → open in a new tab).
 * `src` may arrive RAW ("/api/...", the resolveImageSrc path) or already embedding-rewritten
 * ("/paperclip-api/...", the markdown urlTransform path). resolveContentUrl is idempotent and
 * base-aware, so canonicalizing BOTH sides matches either form with NO hardcoded embedding base
 * (standalone it degrades to a raw string compare). The asset-id fallback accepts either prefix.
 */
export function matchImageAttachmentIndex(
  attachments: ReadonlyArray<{ contentPath: string; assetId?: string | null }>,
  src: string,
): number {
  const canonical = resolveContentUrl(src);
  let idx = attachments.findIndex((a) => resolveContentUrl(a.contentPath) === canonical);
  if (idx < 0) {
    // Asset-id fallback (for query-string / path mismatches). Match "/assets/{id}/content"
    // anywhere in the path so it is base-agnostic — works for "/api", "/paperclip-api", or
    // any custom VITE_PAPERCLIP_API_BASE prefix without hardcoding the embedding base.
    const assetMatch = src.match(/\/assets\/([^/]+)\/content/);
    if (assetMatch) {
      idx = attachments.findIndex((a) => a.assetId === assetMatch[1]);
    }
  }
  return idx;
}

export function isImageAttachment(attachment: Pick<IssueAttachment, "contentType">) {
  return normalizedContentType(attachment).startsWith("image/");
}

export function isVideoAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  const contentType = normalizedContentType(attachment);
  if (isVideoContentType(contentType)) return true;
  if (!GENERIC_ATTACHMENT_CONTENT_TYPES.has(contentType)) return false;

  const filename = (attachment.originalFilename ?? "").toLowerCase();
  return (
    filename.endsWith(".mp4") ||
    filename.endsWith(".m4v") ||
    filename.endsWith(".webm") ||
    filename.endsWith(".mov") ||
    filename.endsWith(".qt") ||
    filename.endsWith(".quicktime")
  );
}

export function isMarkdownAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  const contentType = normalizedContentType(attachment);
  if (
    contentType === "text/markdown" ||
    contentType === "text/x-markdown" ||
    contentType === "application/markdown" ||
    contentType === "application/x-markdown"
  ) {
    return true;
  }

  const filename = (attachment.originalFilename ?? "").toLowerCase();
  if (!filename.endsWith(".md") && !filename.endsWith(".markdown")) return false;
  return contentType === "text/plain" || GENERIC_ATTACHMENT_CONTENT_TYPES.has(contentType);
}
