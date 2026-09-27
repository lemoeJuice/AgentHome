import type { PiImageContent } from "./pi.js";

export const PI_IMAGE_INPUT_MAX_BYTES = 8 * 1024 * 1024;

const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff", "image/avif"]);

export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 2 && data.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (data.length >= 4 && (data.toString("ascii", 0, 4) === "II*\0" || data.toString("ascii", 0, 4) === "MM\0*")) return "image/tiff";
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(data.toString("ascii", 8, 12))) return "image/avif";
  return undefined;
}

/** Verify the media type from bytes before handing an authorized Artifact to a vision model. */
export function piImageContent(bytes: Uint8Array, declaredMime?: string | null): PiImageContent | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > PI_IMAGE_INPUT_MAX_BYTES) return undefined;
  const data = Buffer.from(bytes);
  const mimeType = sniffImageMimeType(data) ?? (declaredMime && supportedMimeTypes.has(declaredMime.toLowerCase()) ? declaredMime.toLowerCase() : undefined);
  return mimeType ? { type: "image", data: data.toString("base64"), mimeType } : undefined;
}
