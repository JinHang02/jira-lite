// Pure helpers for attachments: same-origin file URLs, sizes, kinds, matching ADF media nodes to
// the issue's attachments, and upload limits. No DOM access.

/** The server refuses request bodies over 25 MB (jira_lite/proxy.py MAX_BODY). */
export const MAX_BODY = 25 * 1024 * 1024;
/** Room left for the multipart framing around the files. */
const FRAMING = 64 * 1024;

/** The attachment itself, through the server's same-origin /files/ route (usable in <img>/<a>). */
export const fileUrl = (id) => "/files/content/" + encodeURIComponent(id);
/** Its thumbnail (Jira renders one for images). */
export const thumbUrl = (id) => "/files/thumbnail/" + encodeURIComponent(id);

/** "512 B", "72 KB", "4.9 MB" (1024-based, like Jira). */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)) + " " + units[i];
}

const EXT_KIND = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i, "image"],
  [/\.(mp4|mov|webm|avi|mkv|m4v)$/i, "video"],
  [/\.(mp3|wav|ogg|m4a|flac)$/i, "audio"],
  [/\.pdf$/i, "pdf"],
  [/\.(zip|gz|tgz|tar|7z|rar|bz2|xz)$/i, "archive"],
  [/\.(xlsx?|csv|numbers|ods)$/i, "sheet"],
  [/\.(docx?|odt|rtf|pages)$/i, "doc"],
  [/\.(txt|log|md|json|xml|ya?ml|js|ts|py|java|kt|go|rb|sh|sql|html?|css)$/i, "text"],
];

/** Coarse kind of a file for its icon: image, video, audio, pdf, archive, sheet, doc, text, other. */
export function fileKind(mimeType, filename) {
  const m = String(mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (/zip|compressed|x-tar|gzip|x-7z|x-rar/.test(m)) return "archive";
  if (/spreadsheet|excel|text\/csv/.test(m)) return "sheet";
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(m)) return "doc";
  const hit = EXT_KIND.find(([re]) => re.test(String(filename || "")));
  if (hit) return hit[1];
  return m.startsWith("text/") || /json|xml|javascript/.test(m) ? "text" : "other";
}

/** True for attachments a browser can show in <img>. */
export const isImage = (a) => !!a && fileKind(a.mimeType, a.filename) === "image";

/**
 * The attachment an ADF media node shows, matched by file name (attrs.alt, or attrs.name for
 * some editors): exact first, then ignoring case; the newest wins when several share a name.
 * Returns null when nothing matches (the media id is a Media Services id, not an attachment id).
 */
export function findAttachment(attrs, attachments) {
  const name = String((attrs && (attrs.alt || attrs.name)) || "").trim();
  if (!name || !Array.isArray(attachments) || !attachments.length) return null;
  const newest = (list) => list.reduce((best, a) => (!best || String(a.created || "") > String(best.created || "") ? a : best), null);
  return newest(attachments.filter((a) => a.filename === name))
    || newest(attachments.filter((a) => String(a.filename || "").toLowerCase() === name.toLowerCase()));
}

/** Attachments oldest first (Jira's order is not guaranteed). */
export function sortAttachments(list) {
  return [...(list || [])].sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Splits files picked for upload into {ok, tooBig}: one request carries `ok`, which together
 * must fit the server's body limit; files that don't fit (alone or after the earlier ones) go
 * to `tooBig`.
 */
export function uploadBatch(files, max = MAX_BODY) {
  const ok = [], tooBig = [];
  let total = 0;
  for (const f of files || []) {
    if (total + f.size + FRAMING > max) tooBig.push(f);
    else { ok.push(f); total += f.size; }
  }
  return { ok, tooBig };
}
