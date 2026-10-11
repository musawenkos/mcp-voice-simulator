/**
 * Access token for an exposed simulator (through a tunnel or on the LAN).
 *
 * The page asks for the token once; a correct one gets a cookie that proves it
 * for `maxAgeSeconds`. The cookie is `<expiry>.<HMAC of the expiry keyed by the
 * token>`, so it needs no server-side store, survives a restart, and stops
 * working when the token changes. The token itself is never put in a cookie,
 * URL or log.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const ACCESS_COOKIE = "sim_access";
export const MIN_ACCESS_TOKEN_LENGTH = 16;
export const DEFAULT_ACCESS_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Wrong tokens allowed per window before every attempt is refused until it ends. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

export interface AccessGateOptions {
  token: string;
  /** Set the cookie's Secure flag (the page is served over https). */
  secureCookie: boolean;
  maxAgeSeconds?: number;
  now?: () => number;
}

export type LoginResult = { ok: true; cookie: string } | { ok: false; status: 401 | 429; error: string };

export interface AccessGate {
  /** Whether the request carries a valid, unexpired access cookie. */
  allows(req: http.IncomingMessage): boolean;
  login(token: unknown): LoginResult;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createAccessGate(options: AccessGateOptions): AccessGate {
  if (options.token.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new Error(`The access token must be at least ${MIN_ACCESS_TOKEN_LENGTH} characters.`);
  }
  const now = options.now ?? Date.now;
  const maxAge = options.maxAgeSeconds ?? DEFAULT_ACCESS_MAX_AGE_SECONDS;
  const tokenHash = sha256(options.token);
  const sign = (expiry: number) =>
    createHmac("sha256", options.token).update(`mcp-voice-simulator access ${expiry}`).digest("base64url");
  let failures: number[] = [];

  return {
    allows(req) {
      const value = readCookie(req, ACCESS_COOKIE);
      const match = value?.match(/^(\d{1,15})\.([\w-]{43})$/);
      if (!match) return false;
      const expiry = Number(match[1]);
      if (expiry * 1000 <= now()) return false;
      const expected = Buffer.from(sign(expiry));
      const given = Buffer.from(match[2]);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    login(token) {
      const at = now();
      failures = failures.filter((t) => at - t < FAILURE_WINDOW_MS);
      if (failures.length >= MAX_FAILURES) {
        return { ok: false, status: 429, error: "Too many wrong tokens. Try again in a few minutes." };
      }
      // Compare hashes so the comparison takes the same time whatever the length.
      if (typeof token !== "string" || !timingSafeEqual(sha256(token), tokenHash)) {
        failures.push(at);
        return { ok: false, status: 401, error: "That access token is not right." };
      }
      const expiry = Math.floor(at / 1000) + maxAge;
      const cookie =
        `${ACCESS_COOKIE}=${expiry}.${sign(expiry)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax` +
        (options.secureCookie ? "; Secure" : "");
      return { ok: true, cookie };
    },
  };
}
