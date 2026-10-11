/**
 * Photo capture: the page posts a camera image to `POST /api/photo`, the
 * server checks it and hands it to the host app's `onPhoto` hook (which
 * stores it wherever the MCP server expects, with credentials the browser
 * never sees), and the returned id goes into the next turn's context.
 */
import type http from "node:http";

export const DEFAULT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DEFAULT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export interface PhotoUpload {
  data: Buffer;
  /** The checked content type, one of the allowed photo types. */
  contentType: string;
}

export interface PhotoHookResult {
  /** The id the brain should use for this photo, e.g. the MCP server's upload id. */
  id: string;
  /**
   * Optional utterance the page sends as the next turn straight away (with the
   * photo in its context), e.g. "I just took a photo." Omit to let the user
   * say what to do with it.
   */
  utterance?: string;
}

export type PhotoHook = (photo: PhotoUpload) => Promise<PhotoHookResult> | PhotoHookResult;

export class PhotoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The image type from the file's leading bytes, never from a name or header. */
export function sniffImageType(data: Buffer): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) return "image/gif";
  return undefined;
}

/** Reads a request body, refusing (413) as soon as it passes `maxBytes`. */
export async function readBodyLimited(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      req.destroy();
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function tooLarge(maxBytes: number): PhotoError {
  return new PhotoError(413, `The photo is too big; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
}

/**
 * Checks a posted photo's bytes against the allowed types. The declared type
 * was already checked by the request guard; the bytes decide (a gallery file
 * named .jpg can be a PNG), and the hook gets the type the bytes have.
 */
export function checkPhoto(data: Buffer, types: readonly string[]): PhotoUpload {
  if (!data.length) throw new PhotoError(400, "The photo is empty.");
  const actual = sniffImageType(data);
  if (!actual || !types.includes(actual)) {
    throw new PhotoError(415, `Only ${types.map((t) => t.replace("image/", "")).join(", ")} photos can be uploaded.`);
  }
  return { data, contentType: actual };
}
