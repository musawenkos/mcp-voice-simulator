/**
 * A Cursor local agent restricted to the target MCP server's own tools
 * (`tools: ["mcp"]`, no built-in Read/Edit/Bash) — Cursor itself is the MCP
 * client here, so every tool call in the trace is one Cursor chose to make.
 * Requires the optional peer dependency @cursor/sdk and a CURSOR_API_KEY.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTurnContext } from "./context.js";
import type { Brain, BrainTurnContext, BrainTurnResult } from "./types.js";
import type { ToolCallTrace } from "../mcp.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a voice assistant speaking through a smart display. Replies are read aloud: one to three short sentences, no markdown, no lists.",
  "Use the provided tools for anything the user's request maps to. Prefer the tool whose name or description best matches what they said.",
  "For any tool with a confirm or dryRun parameter: never pass confirm: true or dryRun: false until the user has explicitly agreed in their latest message. Preview first, then ask.",
  "Report tool results faithfully; if a tool returns an error, say so plainly.",
].join(" ");

export interface CursorBrainOptions {
  apiKey: string;
  mcpUrl: string;
  accessToken: () => Promise<string>;
  model?: string;
  systemPrompt?: string;
}

const toolResultText = (result: unknown): string =>
  typeof result === "string"
    ? result
    : Array.isArray((result as { content?: unknown })?.content)
      ? (result as { content: Array<{ type: string; text?: string }> }).content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(" ")
      : JSON.stringify(result ?? "");

export function createCursorBrain(options: CursorBrainOptions): Brain {
  const model = options.model ?? "composer-2.5";
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any = null;
  let needsPersona = true;

  async function ensureAgent() {
    if (agent) return agent;
    const token = await options.accessToken();
    const { Agent } = await import("@cursor/sdk");
    // An empty, source-controlled-nowhere cwd keeps any local .cursor rules
    // in the caller's own project out of the agent's persona.
    const cwd = await mkdtemp(join(tmpdir(), "mcp-sim-"));
    agent = await Agent.create({
      apiKey: options.apiKey,
      model: { id: model },
      tools: ["mcp"],
      mcpServers: {
        target: { type: "http", url: options.mcpUrl, headers: { authorization: `Bearer ${token}` } },
      },
      local: { cwd, settingSources: [] },
    });
    needsPersona = true;
    return agent;
  }

  return {
    name: "cursor",
    async reset() {
      const current = agent;
      agent = null;
      await current?.[Symbol.asyncDispose]?.().catch(() => {});
    },
    async turn(utterance: string, context?: BrainTurnContext): Promise<BrainTurnResult> {
      const currentAgent = await ensureAgent();
      const said = withTurnContext(utterance, context);
      const prompt = needsPersona ? `${systemPrompt}\n\nUser: ${said}` : said;
      needsPersona = false;

      const started = Date.now();
      const run = await currentAgent.send(prompt);
      const calls = new Map<
        string,
        { at: number; name?: string; args?: Record<string, unknown>; result?: unknown; status?: string }
      >();
      let lastAssistantText = "";
      for await (const msg of run.stream()) {
        if (msg.type === "assistant") {
          const text = msg.message.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("");
          if (text) lastAssistantText = text;
        } else if (msg.type === "tool_call") {
          const call = calls.get(msg.call_id) ?? { at: Date.now() };
          calls.set(msg.call_id, {
            ...call,
            name: msg.name,
            args: msg.args ?? call.args,
            result: msg.result ?? call.result,
            status: msg.status,
          });
        }
      }
      const result = await run.wait();
      if (result.status === "error") {
        throw new Error(result.error?.message ?? `Cursor run failed (${result.id})`);
      }

      const trace: ToolCallTrace[] = [...calls.values()].map((call) => ({
        // MCP calls may arrive wrapped as tool name "mcp" with the real tool in args.
        tool: (call.args?.toolName as string | undefined) ?? call.name ?? "unknown",
        args: (call.args?.args as Record<string, unknown> | undefined) ?? call.args ?? {},
        text: toolResultText(call.result),
        isError: call.status === "error",
        ms: call.at - started,
      }));

      return { reply: (result.result ?? lastAssistantText).trim(), trace };
    },
  };
}
