/**
 * A Claude tool-use loop: hands whatever tools/list returned straight to the
 * Messages API and lets the model pick, so this needs no per-server tuning.
 * Requires the optional peer dependency @anthropic-ai/sdk and an
 * ANTHROPIC_API_KEY.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { callTool, type McpSession } from "../mcp.js";
import { withTurnContext } from "./context.js";
import type { Brain, BrainTurnContext, BrainTurnResult } from "./types.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a voice assistant speaking through a smart display. Replies are read aloud: one to three short sentences, no markdown, no lists.",
  "Use the provided tools for anything the user's request maps to. Prefer the tool whose name or description best matches what they said.",
  "For any tool with a confirm or dryRun parameter: never pass confirm: true or dryRun: false until the user has explicitly agreed in their latest message. Preview first, then ask.",
  "Report tool results faithfully; if a tool returns an error, say so plainly.",
].join(" ");

export interface ClaudeBrainOptions {
  apiKey: string;
  session: () => Promise<McpSession>;
  model?: string;
  systemPrompt?: string;
  /** Cap on tool-use rounds per turn, so a confused loop can't run forever. */
  maxToolRounds?: number;
}

type AnthropicMessage = { role: "user" | "assistant"; content: unknown };

export function createClaudeBrain(options: ClaudeBrainOptions): Brain {
  const model = options.model ?? "claude-sonnet-5";
  const maxToolRounds = options.maxToolRounds ?? 6;
  const history: AnthropicMessage[] = [];
  let client: Anthropic | undefined;

  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ apiKey: options.apiKey });
    }
    return client;
  }

  return {
    name: "claude",
    reset() {
      history.length = 0;
    },
    async turn(utterance: string, context?: BrainTurnContext): Promise<BrainTurnResult> {
      const anthropic = await getClient();
      const session = await options.session();
      // The MCP tool's inputSchema is already the JSON Schema shape Anthropic's
      // input_schema expects (both describe tool parameters as JSON Schema);
      // it's typed `unknown` on our side because MCP doesn't constrain it
      // further, so this cast trusts the server rather than guessing a shape.
      const tools: Anthropic.Tool[] = session.tools.map((t) => ({
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      }));
      history.push({ role: "user", content: withTurnContext(utterance, context) });

      const trace: BrainTurnResult["trace"] = [];
      for (let round = 0; round < maxToolRounds; round++) {
        const response = await anthropic.messages.create({
          model,
          max_tokens: 1024,
          system: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
          tools,
          // Anthropic's SDK types its own message history; our stored shape
          // matches what it returns, so this cast is sound in practice.
          messages: history as never,
        });
        history.push({ role: "assistant", content: response.content });

        const toolUses = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );
        if (toolUses.length === 0) {
          const reply = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === "text")
            .map((block) => block.text)
            .join(" ")
            .trim();
          return { reply, trace };
        }

        const results = [];
        for (const use of toolUses) {
          const callResult = await callTool(session, use.name, (use.input ?? {}) as Record<string, unknown>);
          trace.push(callResult);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: callResult.text,
            is_error: callResult.isError,
          });
        }
        history.push({ role: "user", content: results });
      }
      return { reply: "Sorry, that took too many steps. Could you say that again?", trace };
    },
  };
}
