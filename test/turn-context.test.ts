import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Brain, BrainTurnResult } from "../src/brains/types.js";
import { createServer, type CreateServerOptions } from "../src/server.js";
import type { McpSessionManager } from "../src/session.js";

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("/api/turn context and confirmation", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    server?.close();
    if (server) await once(server, "close");
    server = undefined;
  });

  async function start(result: BrainTurnResult, extra: Partial<CreateServerOptions> = {}) {
    const turn = vi.fn().mockResolvedValue(result);
    const brain: Brain = { name: "test", turn: turn as Brain["turn"] };
    const sessionManager = { mcpUrl: "https://mcp.example.com/mcp", invalidate: vi.fn() } as unknown as McpSessionManager;
    server = createServer({ sessionManager, brain, port: 0, ui: false, ...extra });
    await once(server, "listening");
    return { turn, port: (server.address() as AddressInfo).port };
  }

  it("passes no context when there is none", async () => {
    const { turn, port } = await start({ reply: "ok", trace: [] });
    await post(port, "/api/turn", { utterance: "hello" });
    expect(turn).toHaveBeenCalledWith("hello", undefined);
  });

  it("merges the host's context with the page's, the page's keys winning", async () => {
    const { turn, port } = await start(
      { reply: "ok", trace: [] },
      { turnContext: async () => ({ inspector: "t.mokoena", gps: { latitude: 0, longitude: 0 } }) },
    );
    const res = await post(port, "/api/turn", { utterance: "log it here", context: { gps: { latitude: -25.5, longitude: 28.1 } } });
    expect(res.status).toBe(200);
    expect(turn).toHaveBeenCalledWith("log it here", { inspector: "t.mokoena", gps: { latitude: -25.5, longitude: 28.1 } });
  });

  it("rejects context that isn't a JSON object, or is too big", async () => {
    const { turn, port } = await start({ reply: "ok", trace: [] });
    expect((await post(port, "/api/turn", { utterance: "x", context: "gps" })).status).toBe(400);
    expect((await post(port, "/api/turn", { utterance: "x", context: [1] })).status).toBe(400);
    expect((await post(port, "/api/turn", { utterance: "x", context: { blob: "a".repeat(5000) } })).status).toBe(400);
    expect(turn).not.toHaveBeenCalled();
  });

  it("offers Confirm when the brain says a call is waiting, whatever the reply's wording", async () => {
    const { port } = await start({ reply: "That will void observation 7.", trace: [], awaitingConfirmation: true });
    expect((await post(port, "/api/turn", { utterance: "void it" })).json.awaitingConfirm).toBe(true);
  });

  it("still detects a confirmation question in the reply", async () => {
    const { port } = await start({ reply: "Shall I log it?", trace: [] });
    expect((await post(port, "/api/turn", { utterance: "log it" })).json.awaitingConfirm).toBe(true);
  });
});
