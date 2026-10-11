/**
 * HTTP server: a tiny API (`/api/status`, `/api/relink`, `/api/turn`, `/api/reset`,
 * `/api/tts`, `/api/ui/tool-call`) plus the static browser UI in public/, wired to a Brain
 * and an McpSessionManager. With MCP Apps view support on, it also runs the
 * sandbox proxy on a second port (see ui/sandbox.ts).
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAccessGate, type AccessGate } from "./access.js";
import type { Brain, BrainTurnContext } from "./brains/types.js";
import {
  DEFAULT_PHOTO_MAX_BYTES,
  DEFAULT_PHOTO_TYPES,
  PhotoError,
  checkPhoto,
  readBodyLimited,
  type PhotoHook,
} from "./photo.js";
import {
  HTML_SECURITY_HEADERS,
  guardRequest,
  isExposed,
  isLoopbackRequest,
  normalizeExposure,
  type Exposure,
} from "./security.js";
import type { McpSessionManager } from "./session.js";
import { createTtsRoute } from "./tts/route.js";
import type { TtsProvider } from "./tts/types.js";
import { createUiRoute } from "./ui/route.js";
import { createSandboxServer } from "./ui/sandbox.js";

const DEFAULT_PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface CreateServerOptions {
  sessionManager: McpSessionManager;
  brain: Brain;
  port?: number;
  publicDir?: string;
  /** Server-side voice (e.g. ElevenLabs). Omit to use the browser's own, as before. */
  tts?: TtsProvider;
  /** Longest reply sent to the TTS provider, in characters. Default 500. */
  ttsMaxChars?: number;
  /** How many synthesized clips to keep in memory. Default 20; 0 disables. */
  ttsCacheEntries?: number;
  /**
   * MCP Apps `ui://` view support. On by default; `false` shows text only, as a
   * host without MCP Apps would. The sandbox proxy listens on `sandboxPort`
   * (default: the server's port + 1) because the spec requires the host and the
   * sandbox to have different origins.
   */
  ui?: boolean | { sandboxPort?: number };
  /**
   * Context the host app adds to every turn (e.g. the device's location). A
   * `context` object the page sends with the utterance overrides its keys.
   */
  turnContext?: () => BrainTurnContext | undefined | Promise<BrainTurnContext | undefined>;
  /** Address to listen on. Default `127.0.0.1`; anything else exposes the page and needs `accessToken`. */
  host?: string;
  /**
   * Extra `Host` values and a public (tunnel) origin the page may be served
   * from, e.g. to use it on a phone. Setting either needs `accessToken`.
   */
  exposure?: Exposure;
  /**
   * Secret the page asks for once before it works (at least 16 characters).
   * Required when the server is exposed; optional, and then enforced, on loopback.
   */
  accessToken?: string;
  /** How long one entry of the access token lasts, in seconds. Default 12 hours. */
  accessMaxAgeSeconds?: number;
  /**
   * Photo capture: the page's camera button posts images here and the hook
   * stores them (e.g. on the MCP server, with credentials kept server-side),
   * returning the id the next turn's context carries as `photos`. Omit to hide
   * the camera button.
   */
  onPhoto?: PhotoHook;
  /** Largest photo accepted, in bytes. Default 10 MB. */
  photoMaxBytes?: number;
  /** Photo types accepted, checked against the file's bytes. Default JPEG, PNG and WebP. */
  photoTypes?: readonly string[];
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  // A handler that fails after it started answering (a static file vanishing
  // between writeHead and the read) can't send a fresh status; end the response
  // instead of throwing, which would leave the connection open.
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A client mistake, answered with `status` instead of being treated as a dead session. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Turn context comes from the page or a host app; keep it small and plain. */
const MAX_CONTEXT_BYTES = 4096;

function readTurnContext(value: unknown): BrainTurnContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "context must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTEXT_BYTES) {
    throw new HttpError(400, `context must be at most ${MAX_CONTEXT_BYTES} bytes of JSON.`);
  }
  return value as BrainTurnContext;
}

/** Big enough for any request the page sends; stops an exposed server buffering huge bodies. */
const MAX_JSON_BYTES = 1024 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  let body: Buffer;
  try {
    body = await readBodyLimited(req, MAX_JSON_BYTES);
  } catch (err) {
    if (err instanceof PhotoError) throw new HttpError(413, "Request body is too big.");
    throw err;
  }
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString());
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

/** Who may reach the page, checked before listening so a bad setup never starts. */
function accessSetup(options: CreateServerOptions): { exposure: Exposure; gate?: AccessGate } {
  const host = options.host ?? "127.0.0.1";
  const exposure = normalizeExposure(options.exposure);
  const token = options.accessToken?.trim() || undefined;
  if (isExposed(host, exposure) && !token) {
    throw new Error(
      "The simulator is exposed beyond this computer (a non-loopback host, extra allowed hosts or a public origin), " +
        "so it needs an access token: anyone who can reach it could otherwise drive the brain and the linked account.",
    );
  }
  const secureCookie = exposure.publicOrigin?.startsWith("https:") ?? false;
  const gate = token ? createAccessGate({ token, secureCookie, maxAgeSeconds: options.accessMaxAgeSeconds }) : undefined;
  return { exposure, gate };
}

export function createServer(options: CreateServerOptions): http.Server {
  const { exposure, gate } = accessSetup(options);
  const photoTypes = options.photoTypes ?? DEFAULT_PHOTO_TYPES;
  const photoMaxBytes = options.photoMaxBytes ?? DEFAULT_PHOTO_MAX_BYTES;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  let lastAwaitingConfirm = false;
  const tts = createTtsRoute({
    provider: options.tts,
    maxChars: options.ttsMaxChars ?? 500,
    cacheEntries: options.ttsCacheEntries ?? 20,
  });

  const uiEnabled = options.ui !== false;
  const mainPort = options.port ?? 8790;
  const sandboxPort =
    typeof options.ui === "object" && options.ui.sandboxPort !== undefined
      ? options.ui.sandboxPort
      : mainPort === 0
        ? 0
        : mainPort + 1;
  const sandbox = uiEnabled ? createSandboxServer({ port: sandboxPort }) : undefined;
  const ui = createUiRoute({
    enabled: uiEnabled,
    sessionManager: options.sessionManager,
    brainName: options.brain.name,
    sandboxOrigin: () => {
      const address = sandbox?.address();
      return typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : undefined;
    },
  });

  /**
   * MCP Apps views load from the sandbox at http://127.0.0.1:<port+1>, which
   * only exists on this computer. A page opened through a tunnel or the LAN
   * can't reach it, so it's told views are unavailable instead.
   */
  function uiStatusFor(req: http.IncomingMessage, port: number) {
    const status = ui.status();
    if (!status.enabled || isLoopbackRequest(req, port)) return status;
    return { enabled: true, unavailable: "MCP Apps views only work on the computer running the simulator." };
  }

  const server = http.createServer(async (req, res) => {
    try {
      // The port is only known once we're listening (it may have been 0).
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 8790);
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const isPhotoPost = req.method === "POST" && path === "/api/photo" && options.onPhoto !== undefined;
      const guard = guardRequest(req, port, { exposure, postTypes: isPhotoPost ? photoTypes : undefined });
      if (!guard.ok) return json(res, guard.status, { error: guard.error });

      if (gate) {
        if (req.method === "POST" && path === "/api/access") {
          const body = (await readJsonBody(req)) as { token?: unknown };
          const result = gate.login(body.token);
          if (!result.ok) return json(res, result.status, { error: result.error });
          res.setHeader("set-cookie", result.cookie);
          return json(res, 200, { ok: true });
        }
        if (!gate.allows(req)) {
          if (req.method === "GET" && (path === "/" || path === "/index.html")) {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              ...HTML_SECURITY_HEADERS,
            });
            return res.end(await readFile(join(publicDir, "access.html")));
          }
          return json(res, 401, { error: "Enter the access token first.", accessRequired: true });
        }
      }

      if (req.method === "GET" && path === "/api/status") {
        const common = {
          mcpUrl: options.sessionManager.mcpUrl,
          brain: options.brain.name,
          tts: { name: tts.name },
          ui: uiStatusFor(req, port),
          ...(options.onPhoto ? { photos: { maxBytes: photoMaxBytes, types: photoTypes } } : {}),
        };
        // Doesn't wait for the human to finish logging in, so the page can show the link meanwhile.
        const link = await options.sessionManager.linkStatus();
        if (link.state === "pending") {
          return json(res, 200, {
            linked: false,
            ...common,
            linking: true,
            ...(link.url ? { linkUrl: link.url } : {}),
            linkExpiresAt: link.expiresAt.toISOString(),
          });
        }
        if (link.state === "failed") {
          return json(res, 200, {
            linked: false,
            ...common,
            linkFailed: true,
            linkTimedOut: link.timedOut,
            error: link.error,
          });
        }
        try {
          const session = await options.sessionManager.ensureSession();
          return json(res, 200, {
            linked: true,
            ...common,
            tools: session.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              ...(ui.toolView(t) ? { ui: ui.toolView(t) } : {}),
            })),
          });
        } catch (err) {
          return json(res, 200, {
            linked: false,
            ...common,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (req.method === "POST" && path === "/api/relink") {
        // A new login means a new token, which the brain may be holding the old one of.
        options.sessionManager.relink();
        await options.brain.reset?.();
        lastAwaitingConfirm = false;
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/api/turn") {
        const body = (await readJsonBody(req)) as { utterance?: unknown; context?: unknown };
        if (typeof body.utterance !== "string" || !body.utterance.trim()) {
          return json(res, 400, { error: "utterance is required" });
        }
        const sent = readTurnContext(body.context);
        const cleaned = body.utterance.replace(/^\s*(alexa|hey\s+\w+)[,.!]?\s*/i, "").trim();
        const context = { ...(await options.turnContext?.()), ...sent };
        const result = await options.brain.turn(cleaned, Object.keys(context).length ? context : undefined);
        const { reply, trace } = result;
        lastAwaitingConfirm =
          result.awaitingConfirmation === true || /\b(confirm|say yes|shall i|want me to)\b/i.test(reply);
        return json(res, 200, {
          reply,
          trace,
          brain: options.brain.name,
          awaitingConfirm: lastAwaitingConfirm,
          ...(await ui.forTurn(trace)),
        });
      }

      if (isPhotoPost) {
        let photo;
        try {
          photo = checkPhoto(await readBodyLimited(req, photoMaxBytes), photoTypes);
        } catch (err) {
          if (err instanceof PhotoError) return json(res, err.status, { error: err.message });
          throw err;
        }
        let result;
        try {
          result = await options.onPhoto!(photo);
        } catch (err) {
          // The host's storage failed; the MCP session and the brain are fine.
          return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        if (typeof result?.id !== "string" || !result.id.trim()) {
          return json(res, 502, { error: "The photo hook returned no id." });
        }
        return json(res, 200, {
          id: result.id,
          ...(typeof result.utterance === "string" && result.utterance.trim() ? { utterance: result.utterance } : {}),
        });
      }

      if (req.method === "POST" && path === "/api/tts") {
        return await tts.handle(res, await readJsonBody(req));
      }

      if (req.method === "POST" && path === "/api/ui/tool-call") {
        return await ui.handleToolCall(res, await readJsonBody(req));
      }

      if (req.method === "POST" && path === "/api/reset") {
        await options.brain.reset?.();
        lastAwaitingConfirm = false;
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS });
        return res.end(await readFile(join(publicDir, "index.html")));
      }

      if (req.method === "GET" && path === "/tts.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" });
        return res.end(await readFile(join(publicDir, "tts.js")));
      }

      if (req.method === "GET" && path === "/host.js") {
        const file = await readFile(join(publicDir, "host.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" });
        return res.end(file);
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      // A dead session (server restarted, token expired) should relink next turn.
      options.sessionManager.invalidate();
      await options.brain.reset?.();
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("close", () => sandbox?.close());
  server.listen(mainPort, options.host ?? "127.0.0.1");
  return server;
}
