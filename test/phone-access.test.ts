import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCESS_COOKIE, createAccessGate } from "../src/access.js";
import type { Brain } from "../src/brains/types.js";
import { sniffImageType } from "../src/photo.js";
import { allowedHosts, allowedOrigins, guardRequest, isExposed, normalizeExposure } from "../src/security.js";
import { createServer, type CreateServerOptions } from "../src/server.js";
import type { McpSessionManager } from "../src/session.js";

const TOKEN = "correct-horse-battery-staple";
const TUNNEL = "https://abc-def.trycloudflare.com";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from("GIF89a......", "latin1");

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
      );
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

let server: http.Server | undefined;
afterEach(async () => {
  server?.close();
  if (server) await once(server, "close");
  server = undefined;
});

async function start(extra: Partial<CreateServerOptions> = {}) {
  const turn = vi.fn().mockResolvedValue({ reply: "ok", trace: [] });
  const brain: Brain = { name: "test", turn: turn as Brain["turn"], reset: vi.fn() };
  const sessionManager = {
    mcpUrl: "https://mcp.example.com/mcp",
    linkStatus: async () => ({ state: "linked" }),
    ensureSession: async () => ({ tools: [] }),
    invalidate: vi.fn(),
  } as unknown as McpSessionManager;
  server = createServer({ sessionManager, brain, port: 0, ui: false, ...extra });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { turn, port, local: `127.0.0.1:${port}` };
}

/** Logs in with the token and returns the cookie to send. */
async function login(port: number, host: string, origin?: string): Promise<string> {
  const res = await send(port, "POST", "/api/access", {
    headers: { host, "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(res.status).toBe(200);
  const cookie = String(res.headers["set-cookie"]).split(";")[0];
  expect(cookie.startsWith(`${ACCESS_COOKIE}=`)).toBe(true);
  return cookie;
}

describe("allowed hosts for tunnels and the LAN", () => {
  const req = (headers: Record<string, string>, method = "GET") =>
    ({ headers, method }) as unknown as http.IncomingMessage;

  it("rejects a tunnel's Host and Origin unless they're configured", () => {
    expect(guardRequest(req({ host: "abc-def.trycloudflare.com" }), 8790)).toMatchObject({ ok: false, status: 403 });
    expect(
      guardRequest(req({ host: "127.0.0.1:8790", origin: TUNNEL, "content-type": "application/json" }, "POST"), 8790),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts exactly the configured public origin, and nothing else on the same domain", () => {
    const exposure = { publicOrigin: TUNNEL };
    expect(allowedHosts(8790, exposure)).toContain("abc-def.trycloudflare.com");
    expect(allowedOrigins(8790, exposure)).toContain(TUNNEL);
    const post = (host: string, origin: string) =>
      guardRequest(req({ host, origin, "content-type": "application/json" }, "POST"), 8790, { exposure });
    expect(post("abc-def.trycloudflare.com", TUNNEL)).toEqual({ ok: true });
    expect(post("evil.trycloudflare.com", "https://evil.trycloudflare.com")).toMatchObject({ ok: false, status: 403 });
    expect(post("abc-def.trycloudflare.com", "https://evil.trycloudflare.com")).toMatchObject({ ok: false, status: 403 });
    expect(post("abc-def.trycloudflare.com", "http://abc-def.trycloudflare.com")).toMatchObject({ ok: false });
  });

  it("accepts extra hosts by exact Host value, over http or https", () => {
    const exposure = { allowedHosts: ["192.168.1.20:8790"] };
    expect(guardRequest(req({ host: "192.168.1.20:8790", origin: "http://192.168.1.20:8790" }), 8790, { exposure })).toEqual({
      ok: true,
    });
    expect(guardRequest(req({ host: "192.168.1.20" }), 8790, { exposure })).toMatchObject({ ok: false });
  });

  it("refuses wildcards, paths and credentials in the configuration", () => {
    expect(() => normalizeExposure({ allowedHosts: ["*.trycloudflare.com"] })).toThrow();
    expect(() => normalizeExposure({ allowedHosts: ["https://host"] })).toThrow();
    expect(() => normalizeExposure({ publicOrigin: "https://abc.trycloudflare.com/app" })).toThrow();
    expect(() => normalizeExposure({ publicOrigin: "https://user:pw@abc.trycloudflare.com" })).toThrow();
    expect(() => normalizeExposure({ publicOrigin: "ftp://abc.example" })).toThrow();
    expect(normalizeExposure({ publicOrigin: "HTTPS://ABC.trycloudflare.com/" }).publicOrigin).toBe("https://abc.trycloudflare.com");
  });

  it("counts a non-loopback bind or any extension as exposed", () => {
    expect(isExposed("127.0.0.1")).toBe(false);
    expect(isExposed("localhost", {})).toBe(false);
    expect(isExposed("0.0.0.0")).toBe(true);
    expect(isExposed("127.0.0.1", { publicOrigin: TUNNEL })).toBe(true);
    expect(isExposed("127.0.0.1", { allowedHosts: ["phone.local:8790"] })).toBe(true);
  });

  it("only accepts a POST's content type from the list it's given", () => {
    const post = (type: string, postTypes?: string[]) =>
      guardRequest(req({ host: "127.0.0.1:8790", "content-type": type }, "POST"), 8790, { postTypes });
    expect(post("image/jpeg")).toMatchObject({ ok: false, status: 415 });
    expect(post("image/jpeg", ["image/jpeg"])).toEqual({ ok: true });
    expect(post("text/plain", ["image/jpeg"])).toMatchObject({ ok: false, status: 415 });
  });
});

describe("access token", () => {
  it("refuses to start exposed without a token, or with a short one", () => {
    const options = {
      sessionManager: {} as McpSessionManager,
      brain: { name: "x", turn: vi.fn() } as unknown as Brain,
      port: 0,
      ui: false as const,
    };
    expect(() => createServer({ ...options, host: "0.0.0.0" })).toThrow(/access token/);
    expect(() => createServer({ ...options, exposure: { publicOrigin: TUNNEL } })).toThrow(/access token/);
    expect(() => createServer({ ...options, exposure: { allowedHosts: ["192.168.1.20:8790"] } })).toThrow(/access token/);
    expect(() => createServer({ ...options, exposure: { publicOrigin: TUNNEL }, accessToken: "short" })).toThrow(/16/);
  });

  it("keeps today's behaviour with no token on loopback", async () => {
    const { port, local } = await start();
    expect((await send(port, "GET", "/api/status", { headers: { host: local } })).status).toBe(200);
  });

  it("asks for the token on the page and refuses the API until it's given", async () => {
    const { turn, port } = await start({ exposure: { publicOrigin: TUNNEL }, accessToken: TOKEN });
    const host = "abc-def.trycloudflare.com";

    const page = await send(port, "GET", "/", { headers: { host } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Access token");
    expect(page.headers["x-frame-options"]).toBe("DENY");

    const status = await send(port, "GET", "/api/status", { headers: { host } });
    expect(status.status).toBe(401);
    const turnRes = await send(port, "POST", "/api/turn", {
      headers: { host, origin: TUNNEL, "content-type": "application/json" },
      body: JSON.stringify({ utterance: "confirm" }),
    });
    expect(turnRes.status).toBe(401);
    expect(turn).not.toHaveBeenCalled();
    for (const path of ["/tts.js", "/host.js"]) {
      expect((await send(port, "GET", path, { headers: { host } })).status, path).toBe(401);
    }
  });

  it("rejects a wrong token and accepts the right one with an HttpOnly, Secure cookie", async () => {
    const { turn, port } = await start({ exposure: { publicOrigin: TUNNEL }, accessToken: TOKEN });
    const host = "abc-def.trycloudflare.com";
    const wrong = await send(port, "POST", "/api/access", {
      headers: { host, origin: TUNNEL, "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const res = await send(port, "POST", "/api/access", {
      headers: { host, origin: TUNNEL, "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toContain(TOKEN);

    const cookie = setCookie.split(";")[0];
    const status = await send(port, "GET", "/api/status", { headers: { host, cookie } });
    expect(status.status).toBe(200);
    const ok = await send(port, "POST", "/api/turn", {
      headers: { host, origin: TUNNEL, cookie, "content-type": "application/json" },
      body: JSON.stringify({ utterance: "hello" }),
    });
    expect(ok.status).toBe(200);
    expect(turn).toHaveBeenCalledOnce();
    const page = await send(port, "GET", "/", { headers: { host, cookie } });
    expect(page.body).toContain("MCP voice simulator");
  });

  it("still applies the Origin check to a logged-in browser (CSRF)", async () => {
    const { turn, port } = await start({ exposure: { publicOrigin: TUNNEL }, accessToken: TOKEN });
    const host = "abc-def.trycloudflare.com";
    const cookie = await login(port, host, TUNNEL);
    const res = await send(port, "POST", "/api/turn", {
      headers: { host, origin: "https://attacker.example", cookie, "content-type": "application/json" },
      body: JSON.stringify({ utterance: "confirm" }),
    });
    expect(res.status).toBe(403);
    expect(turn).not.toHaveBeenCalled();
  });

  it("enforces a token on loopback too when one is set, without the Secure flag", async () => {
    const { port, local } = await start({ accessToken: TOKEN });
    expect((await send(port, "GET", "/api/status", { headers: { host: local } })).status).toBe(401);
    const res = await send(port, "POST", "/api/access", {
      headers: { host: local, "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/);
  });

  it("rejects tampered, expired and other-token cookies", () => {
    let now = 1_000_000_000_000;
    const gate = createAccessGate({ token: TOKEN, secureCookie: true, maxAgeSeconds: 60, now: () => now });
    const result = gate.login(TOKEN);
    if (!result.ok) throw new Error("login failed");
    const cookie = result.cookie.split(";")[0];
    const withCookie = (c: string) => ({ headers: { cookie: c } }) as unknown as http.IncomingMessage;

    expect(gate.allows(withCookie(cookie))).toBe(true);
    expect(gate.allows(withCookie(`other=1; ${cookie}`))).toBe(true);
    const [, value] = cookie.split("=");
    const [expiry, sig] = value.split(".");
    expect(gate.allows(withCookie(`${ACCESS_COOKIE}=${Number(expiry) + 3600}.${sig}`))).toBe(false);
    expect(gate.allows(withCookie(`${ACCESS_COOKIE}=${expiry}.${sig.slice(0, -1)}A`))).toBe(sig.endsWith("A"));
    expect(gate.allows(withCookie(`${ACCESS_COOKIE}=${TOKEN}`))).toBe(false);

    const other = createAccessGate({ token: "another-token-of-16+", secureCookie: true, now: () => now });
    expect(other.allows(withCookie(cookie))).toBe(false);

    now += 61_000;
    expect(gate.allows(withCookie(cookie))).toBe(false);
  });

  it("locks out after repeated wrong tokens", () => {
    let now = 0;
    const gate = createAccessGate({ token: TOKEN, secureCookie: false, now: () => now });
    for (let i = 0; i < 10; i++) expect(gate.login("wrong")).toMatchObject({ ok: false, status: 401 });
    expect(gate.login(TOKEN)).toMatchObject({ ok: false, status: 429 });
    now += 11 * 60_000;
    expect(gate.login(TOKEN)).toMatchObject({ ok: true });
  });
});

describe("photo upload hook", () => {
  const upload = (port: number, host: string, type: string, body: Buffer, extra: Record<string, string> = {}) =>
    send(port, "POST", "/api/photo", { headers: { host, "content-type": type, ...extra }, body });

  it("is off without a hook: no camera in the status, and no image POSTs", async () => {
    const { port, local } = await start();
    const status = JSON.parse((await send(port, "GET", "/api/status", { headers: { host: local } })).body);
    expect(status.photos).toBeUndefined();
    expect((await upload(port, local, "image/jpeg", JPEG)).status).toBe(415);
  });

  it("hands a checked photo to the hook and returns its id and follow-up utterance", async () => {
    const onPhoto = vi.fn().mockResolvedValue({ id: "photo-1", utterance: "I just took a photo." });
    const { port, local } = await start({ onPhoto });
    const status = JSON.parse((await send(port, "GET", "/api/status", { headers: { host: local } })).body);
    expect(status.photos).toEqual({ maxBytes: 10 * 1024 * 1024, types: ["image/jpeg", "image/png", "image/webp"] });

    const res = await upload(port, local, "image/jpeg", JPEG, { origin: `http://${local}` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: "photo-1", utterance: "I just took a photo." });
    expect(onPhoto).toHaveBeenCalledWith({ data: JPEG, contentType: "image/jpeg" });
  });

  it("uses the type the bytes have, whatever the request said", async () => {
    const onPhoto = vi.fn().mockResolvedValue({ id: "p" });
    const { port, local } = await start({ onPhoto });
    expect((await upload(port, local, "image/jpeg", PNG)).status).toBe(200);
    expect(onPhoto).toHaveBeenCalledWith({ data: PNG, contentType: "image/png" });
  });

  it("rejects types outside the allow-list, by header and by content", async () => {
    const onPhoto = vi.fn().mockResolvedValue({ id: "p" });
    const { port, local } = await start({ onPhoto });
    expect((await upload(port, local, "text/plain", JPEG)).status).toBe(415);
    expect((await upload(port, local, "image/gif", GIF)).status).toBe(415);
    expect((await upload(port, local, "image/jpeg", GIF)).status).toBe(415);
    expect((await upload(port, local, "image/jpeg", Buffer.from("<svg onload=alert(1)>"))).status).toBe(415);
    expect((await upload(port, local, "image/jpeg", Buffer.alloc(0))).status).toBe(400);
    expect(onPhoto).not.toHaveBeenCalled();
  });

  it("rejects a photo over the size limit before calling the hook", async () => {
    const onPhoto = vi.fn().mockResolvedValue({ id: "p" });
    const { port, local } = await start({ onPhoto, photoMaxBytes: 1024 });
    const big = Buffer.concat([JPEG, Buffer.alloc(2048)]);
    const res = await upload(port, local, "image/jpeg", big);
    expect(res.status).toBe(413);
    expect(onPhoto).not.toHaveBeenCalled();
    expect((await upload(port, local, "image/jpeg", Buffer.concat([JPEG, Buffer.alloc(100)]))).status).toBe(200);
  });

  it("rejects a cross-origin upload (CSRF) and needs the access token when one is set", async () => {
    const onPhoto = vi.fn().mockResolvedValue({ id: "p" });
    const { port, local } = await start({ onPhoto, accessToken: TOKEN });
    expect((await upload(port, local, "image/jpeg", JPEG, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await upload(port, local, "image/jpeg", JPEG)).status).toBe(401);
    const cookie = await login(port, local);
    expect((await upload(port, local, "image/jpeg", JPEG, { cookie })).status).toBe(200);
    expect(onPhoto).toHaveBeenCalledOnce();
  });

  it("reports a failing hook as 502 without dropping the MCP session", async () => {
    const onPhoto = vi.fn().mockRejectedValue(new Error("storage is down"));
    const { port, local } = await start({ onPhoto });
    const res = await upload(port, local, "image/jpeg", JPEG);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBe("storage is down");
  });

  it("sniffs JPEG, PNG, WebP and GIF", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(Buffer.from("hello world!"))).toBeUndefined();
  });
});

describe("turn context from the device", () => {
  it("merges the page's location and photos with the host's context", async () => {
    const { turn, port, local } = await start({ turnContext: () => ({ inspector: "t.mokoena", localTime: "10:00" }) });
    const location = {
      latitude: -25.3951,
      longitude: 28.2799,
      accuracyMeters: 8,
      timestamp: "2026-10-11T10:00:00.000Z",
      ageSeconds: 2,
    };
    const res = await send(port, "POST", "/api/turn", {
      headers: { host: local, "content-type": "application/json" },
      body: JSON.stringify({ utterance: "log a pothole here", context: { location, photos: ["photo-1"] } }),
    });
    expect(res.status).toBe(200);
    expect(turn).toHaveBeenCalledWith("log a pothole here", {
      inspector: "t.mokoena",
      localTime: "10:00",
      location,
      photos: ["photo-1"],
    });
  });

  it("refuses a request body over the JSON limit", async () => {
    const { turn, port, local } = await start();
    const res = await send(port, "POST", "/api/turn", {
      headers: { host: local, "content-type": "application/json" },
      body: JSON.stringify({ utterance: "x".repeat(1024 * 1024 + 10) }),
    });
    expect(res.status).toBe(413);
    expect(turn).not.toHaveBeenCalled();
  });
});

describe("MCP Apps views from another device", () => {
  it("are reported unavailable through a tunnel, but stay on locally", async () => {
    const { port, local } = await start({ ui: true, exposure: { publicOrigin: TUNNEL }, accessToken: TOKEN });
    const host = "abc-def.trycloudflare.com";
    const remote = JSON.parse(
      (await send(port, "GET", "/api/status", { headers: { host, cookie: await login(port, host, TUNNEL) } })).body,
    );
    expect(remote.ui.enabled).toBe(true);
    expect(remote.ui.sandboxOrigin).toBeUndefined();
    expect(remote.ui.unavailable).toMatch(/only work on the computer/);

    const here = JSON.parse((await send(port, "GET", "/api/status", { headers: { host: local, cookie: await login(port, local) } })).body);
    expect(here.ui.sandboxOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
