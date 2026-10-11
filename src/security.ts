/**
 * Guards for the simulator's local HTTP API.
 *
 * By default the server only listens on 127.0.0.1, but that alone doesn't stop a
 * web page open in the same browser from talking to it:
 *
 *  - CSRF: a page can send a cross-origin "simple" POST (`text/plain`, no CORS
 *    preflight) to http://127.0.0.1:<port>/api/turn, which would run a brain
 *    turn on the user's linked MCP account and LLM key.
 *  - DNS rebinding: a page on attacker.example (resolving to 127.0.0.1) can
 *    read and write the API as "same origin", with `Host: attacker.example`.
 *
 * So every request must carry an allowed `Host`, any `Origin` must be this
 * server's own, and POSTs must be JSON (which a cross-origin page can't send
 * without a preflight, and we send no CORS headers). The photo upload takes an
 * image type instead, which isn't a CORS "simple" type either.
 *
 * To use the page from a phone (through an HTTPS tunnel, or on the LAN), the
 * allowed hosts and origins can be extended explicitly with `Exposure`; nothing
 * is ever matched by wildcard. An exposed server also needs an access token
 * (see access.ts), since anyone who can reach it could otherwise drive the brain.
 */
import type http from "node:http";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];
const LOOPBACK_BIND = ["127.0.0.1", "localhost", "::1"];

/** Ways the page may be reached besides http://127.0.0.1:<port> and http://localhost:<port>. */
export interface Exposure {
  /**
   * Extra `Host` header values, exactly as the browser sends them: a host name
   * or IP, with `:port` unless it's the scheme's default (e.g. `192.168.1.20:8790`).
   * The page may then be served from `http://` or `https://` that host.
   */
  allowedHosts?: string[];
  /**
   * The public origin a tunnel serves the page at, e.g. `https://abc.trycloudflare.com`.
   * Its host is allowed as a `Host` header and the origin as an `Origin` header.
   */
  publicOrigin?: string;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/;

/**
 * Validates and lower-cases an `Exposure`, throwing on anything that isn't a
 * plain host or origin (no wildcards, paths or credentials).
 */
export function normalizeExposure(exposure: Exposure = {}): { allowedHosts: string[]; publicOrigin?: string } {
  const allowedHosts = (exposure.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const host of allowedHosts) {
    if (!HOST_PATTERN.test(host)) {
      throw new Error(`Allowed host "${host}" must be a host name or IP, optionally with :port (no scheme, path or wildcard).`);
    }
  }
  let publicOrigin: string | undefined;
  if (exposure.publicOrigin?.trim()) {
    let url: URL;
    try {
      url = new URL(exposure.publicOrigin.trim());
    } catch {
      throw new Error(`Public origin "${exposure.publicOrigin}" is not a URL, e.g. https://abc.trycloudflare.com.`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error(`Public origin "${exposure.publicOrigin}" must be an http(s) origin without credentials.`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Public origin "${exposure.publicOrigin}" must be just the origin, without a path.`);
    }
    publicOrigin = url.origin;
  }
  return { allowedHosts, publicOrigin };
}

/** Whether a server bound to `bindHost` with this exposure can be reached from other devices. */
export function isExposed(bindHost: string, exposure: Exposure = {}): boolean {
  const { allowedHosts, publicOrigin } = normalizeExposure(exposure);
  return !LOOPBACK_BIND.includes(bindHost.toLowerCase()) || allowedHosts.length > 0 || publicOrigin !== undefined;
}

/** `Host` header values this server may legitimately be reached as. */
export function allowedHosts(port: number, exposure?: Exposure): string[] {
  const { allowedHosts: extra, publicOrigin } = normalizeExposure(exposure);
  return [
    ...LOOPBACK_HOSTS.map((h) => `${h}:${port}`),
    ...extra,
    ...(publicOrigin ? [new URL(publicOrigin).host] : []),
  ];
}

/** `Origin` header values that are this server itself. */
export function allowedOrigins(port: number, exposure?: Exposure): string[] {
  const { allowedHosts: extra, publicOrigin } = normalizeExposure(exposure);
  return [
    ...LOOPBACK_HOSTS.map((h) => `http://${h}:${port}`),
    ...extra.flatMap((h) => [`http://${h}`, `https://${h}`]),
    ...(publicOrigin ? [publicOrigin] : []),
  ];
}

/** Whether the request reached the server by its loopback name (not through a tunnel or the LAN). */
export function isLoopbackRequest(req: http.IncomingMessage, port: number): boolean {
  const host = header(req, "host")?.toLowerCase();
  return host !== undefined && LOOPBACK_HOSTS.map((h) => `${h}:${port}`).includes(host);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface GuardOptions {
  exposure?: Exposure;
  /** Content types this POST may have. Default: JSON only. */
  postTypes?: readonly string[];
}

export function guardRequest(req: http.IncomingMessage, port: number, options: GuardOptions = {}): GuardResult {
  const host = header(req, "host")?.toLowerCase();
  if (!host || !allowedHosts(port, options.exposure).includes(host)) {
    return { ok: false, status: 403, error: "Forbidden: unexpected Host header." };
  }

  const origin = header(req, "origin");
  if (origin !== undefined && !allowedOrigins(port, options.exposure).includes(origin.toLowerCase())) {
    return { ok: false, status: 403, error: "Forbidden: cross-origin requests are not allowed." };
  }

  if (req.method === "POST") {
    const allowed = options.postTypes ?? ["application/json"];
    const type = header(req, "content-type")?.split(";")[0].trim().toLowerCase();
    if (!type || !allowed.includes(type)) {
      return { ok: false, status: 415, error: `POST requests here must be ${allowed.join(" or ")}.` };
    }
  }

  return { ok: true };
}

/** Headers for the HTML page: it has a Confirm button and talks to a linked account,
 *  so it must not be framed by another site. */
export const HTML_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
