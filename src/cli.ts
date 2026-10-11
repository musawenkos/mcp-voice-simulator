#!/usr/bin/env node
import { createBedrockBrain } from "./brains/bedrock.js";
import { createClaudeBrain } from "./brains/claude.js";
import { createCursorBrain } from "./brains/cursor.js";
import type { Brain } from "./brains/types.js";
import { createServer } from "./server.js";
import { McpSessionManager } from "./session.js";
import { ttsConfigFromEnv, type TtsConfig } from "./tts/config.js";

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function fail(message: string): never {
  console.error(`mcp-voice-simulator: ${message}`);
  process.exit(1);
}

const mcpUrl = env("MCP_URL");
if (!mcpUrl) fail("MCP_URL is required — the full URL of the MCP endpoint to simulate against.");

const port = Number(env("SIM_PORT") ?? 8790);
const anthropicKey = env("ANTHROPIC_API_KEY");
const cursorKey = env("CURSOR_API_KEY");
const forcedBrain = env("SIM_BRAIN");

const simUi = (env("SIM_UI") ?? "on").toLowerCase();
if (simUi !== "on" && simUi !== "off") fail(`SIM_UI must be "on" or "off" (got "${simUi}").`);
const uiEnabled = simUi === "on";
const sandboxPortRaw = env("SIM_SANDBOX_PORT");
const sandboxPort = sandboxPortRaw === undefined ? undefined : Number(sandboxPortRaw);
if (sandboxPort !== undefined && (!Number.isInteger(sandboxPort) || sandboxPort < 0 || sandboxPort > 65535)) {
  fail(`SIM_SANDBOX_PORT must be a port number (got "${sandboxPortRaw}").`);
}

// First-time linking can take a while (consent screens for each connected provider), so longer than the library's 2 minutes.
const DEFAULT_LINK_TIMEOUT_MS = 300_000;
const MAX_TIMER_MS = 2_147_483_647; // setTimeout's limit; anything larger fires immediately
const linkTimeoutRaw = env("SIM_LINK_TIMEOUT_MS");
const linkTimeoutMs = linkTimeoutRaw === undefined ? DEFAULT_LINK_TIMEOUT_MS : Number(linkTimeoutRaw);
if (!Number.isInteger(linkTimeoutMs) || linkTimeoutMs <= 0 || linkTimeoutMs > MAX_TIMER_MS) {
  fail(`SIM_LINK_TIMEOUT_MS must be a number of milliseconds between 1 and ${MAX_TIMER_MS} (got "${linkTimeoutRaw}").`);
}

const sessionManager = new McpSessionManager({
  mcpUrl,
  bearerToken: env("MCP_BEARER_TOKEN"),
  link: { clientId: env("MCP_CLIENT_ID"), timeoutMs: linkTimeoutMs },
  ui: uiEnabled,
});

function pickBrainName(): "claude" | "cursor" | "bedrock" {
  if (forcedBrain === "claude" || forcedBrain === "cursor" || forcedBrain === "bedrock") return forcedBrain;
  if (forcedBrain) fail(`SIM_BRAIN must be "claude", "cursor" or "bedrock" (got "${forcedBrain}").`);
  if (cursorKey) return "cursor";
  if (anthropicKey) return "claude";
  fail(
    "No brain available — set CURSOR_API_KEY or ANTHROPIC_API_KEY, or SIM_BRAIN=bedrock with AWS credentials " +
      "(there's no built-in key-free brain, " +
      "since picking tools from natural language needs an LLM unless you write your own for your specific " +
      "tools — see examples/ and use the programmatic API instead of this CLI to supply one).",
  );
}

const brainName = pickBrainName();
// The AWS SDK finds credentials itself (AWS_PROFILE, SSO, env vars...) but
// fails late and vaguely without a region, so check for one up front.
const awsRegion = env("AWS_REGION") ?? env("AWS_DEFAULT_REGION");
if (brainName === "bedrock" && !awsRegion && !env("AWS_PROFILE")) {
  fail("The Bedrock brain needs AWS_REGION (e.g. us-east-1), or an AWS_PROFILE whose config sets a region.");
}
const brain: Brain =
  brainName === "cursor"
    ? createCursorBrain({
        apiKey: cursorKey!,
        mcpUrl,
        accessToken: () => sessionManager.accessToken(),
        model: env("SIM_CURSOR_MODEL"),
      })
    : brainName === "bedrock"
      ? createBedrockBrain({
          session: () => sessionManager.ensureSession(),
          model: env("SIM_BEDROCK_MODEL"),
          region: awsRegion,
        })
      : createClaudeBrain({
          apiKey: anthropicKey!,
          session: () => sessionManager.ensureSession(),
          model: env("SIM_MODEL"),
        });

let tts: TtsConfig;
try {
  tts = ttsConfigFromEnv(process.env);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// Reaching the page from another device (a phone through a tunnel, or the LAN). See the README.
const host = env("SIM_HOST") ?? "127.0.0.1";
const exposure = {
  allowedHosts: env("SIM_ALLOWED_HOSTS")?.split(","),
  publicOrigin: env("SIM_PUBLIC_ORIGIN"),
};
try {
  createServer({
    sessionManager,
    brain,
    port,
    host,
    exposure,
    accessToken: env("SIM_ACCESS_TOKEN"),
    tts: tts.provider,
    ttsMaxChars: tts.maxChars,
    ttsCacheEntries: tts.cacheEntries,
    ui: uiEnabled ? { sandboxPort } : false,
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  fail(/access token/.test(message) ? `${message} Set SIM_ACCESS_TOKEN (at least 16 characters).` : message);
}
console.log(`mcp-voice-simulator: http://127.0.0.1:${port}`);
if (exposure.publicOrigin) console.log(`  Public page: ${exposure.publicOrigin} (access token required)`);
else if (host !== "127.0.0.1" || exposure.allowedHosts) console.log(`  Listening on ${host} (access token required)`);
console.log(`  MCP server: ${mcpUrl}`);
console.log(`  Brain: ${brainName}`);
console.log(`  Voice: ${tts.provider?.name ?? "browser"}`);
console.log(`  Views (MCP Apps): ${uiEnabled ? "on" : "off"}`);
if (tts.hint) console.log(`  Note: ${tts.hint}`);
