/**
 * An Amazon Bedrock Converse API tool-use loop: hands whatever tools/list
 * returned to the model as Bedrock tools and lets it pick, so this needs no
 * per-server tuning, and any Bedrock model that supports tool use can drive
 * it. Requires the optional peer dependency @aws-sdk/client-bedrock-runtime
 * and AWS credentials from the standard chain (AWS_PROFILE, environment
 * variables, SSO, an instance role...).
 *
 * Mutating tool calls go through a ConfirmationGate (see confirm.ts): the
 * model can't make one in the same turn it decided to.
 */
import { ProtocolError } from "@modelcontextprotocol/client";

import { callTool, type McpSession, type McpTool, type ToolCallTrace } from "../mcp.js";
import { ConfirmationGate, heldCallMessage, type ClassifyToolCall } from "./confirm.js";
import { withTurnContext } from "./context.js";
import type { Brain, BrainTurnContext, BrainTurnResult } from "./types.js";

export const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a voice assistant speaking through a smart display. Replies are read aloud: one to three short sentences, no markdown, no lists.",
  "Use the provided tools for anything the user's request maps to. Prefer the tool whose name or description best matches what they said.",
  "For any tool with a confirm or dryRun parameter: never pass confirm: true or dryRun: false until the user has explicitly agreed in their latest message. Preview first, then ask.",
  "Report tool results faithfully; if a tool returns an error, say so plainly.",
].join(" ");

const STEP_LIMIT_REPLY = "Sorry, that took too many steps. Could you say that again?";
const EMPTY_REPLY = "Sorry, I don't have an answer for that.";

/** The part of a BedrockRuntimeClient this brain uses; pass a fake in tests. */
export interface BedrockClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface BedrockBrainOptions {
  session: () => Promise<McpSession>;
  /** A Bedrock model or inference profile id. Default `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. */
  model?: string;
  /** AWS region. Default: the SDK's own (AWS_REGION, then the profile's). */
  region?: string;
  /** Named AWS profile. Default: the SDK's own (AWS_PROFILE, then `default`). */
  profile?: string;
  systemPrompt?: string;
  /** Most tool calls per turn; then the model must answer with what it has. Default 8. */
  maxSteps?: number;
  /** Longest reply per model call, in tokens. Default 1024. */
  maxTokens?: number;
  /** Which tool calls need the user's yes first. Default: every tool not
   *  annotated `readOnlyHint`, apart from preview calls (see confirm.ts).
   *  Return `undefined` to fall back to the default for a call. */
  classifyToolCall?: ClassifyToolCall;
  /** Use this client instead of creating one, e.g. a fake in tests. */
  client?: BedrockClientLike;
}

// Bedrock's Converse shapes, as far as this brain uses them. Typed locally so
// the published types don't depend on the optional AWS SDK.
type ContentBlock = {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input?: unknown };
  toolResult?: {
    toolUseId: string;
    content: Array<{ text?: string; json?: unknown }>;
    status?: "success" | "error";
  };
  [other: string]: unknown;
};
type Message = { role: "user" | "assistant"; content: ContentBlock[] };
type ConverseOutput = { output?: { message?: Message }; stopReason?: string };

/** Bedrock tool names must match [a-zA-Z0-9_-]{1,64}; MCP's may not. */
function bedrockToolNames(tools: McpTool[]): Map<string, McpTool> {
  const byName = new Map<string, McpTool>();
  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    let name = base;
    for (let n = 2; byName.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
    byName.set(name, tool);
  }
  return byName;
}

function toolSpec(name: string, tool: McpTool) {
  // An MCP inputSchema is JSON Schema for an object, which is what Bedrock's
  // inputSchema.json takes. A tool may omit it; Bedrock still needs one.
  const schema = (tool.inputSchema as Record<string, unknown> | undefined) ?? {};
  return {
    toolSpec: {
      name,
      // Bedrock rejects an empty description.
      description: tool.description || tool.title || tool.name,
      inputSchema: { json: { ...schema, type: "object", properties: schema.properties ?? {} } },
    },
  };
}

const textOf = (content: ContentBlock[]) =>
  content
    .map((block) => block.text ?? "")
    .join(" ")
    .trim();

function toolResultBlock(toolUseId: string, call: ToolCallTrace): ContentBlock {
  // Bedrock rejects an empty text block; fall back to the structured result.
  const structured = call.result?.structuredContent;
  const content = call.text
    ? [{ text: call.text }]
    : structured && typeof structured === "object" && !Array.isArray(structured)
      ? [{ json: structured }]
      : [{ text: "(the tool returned no text)" }];
  return { toolResult: { toolUseId, content, status: call.isError ? "error" : "success" } };
}

const errorResult = (toolUseId: string, text: string): ContentBlock => ({
  toolResult: { toolUseId, content: [{ text }], status: "error" },
});

export function createBedrockBrain(options: BedrockBrainOptions): Brain {
  const model = options.model ?? DEFAULT_BEDROCK_MODEL;
  const maxSteps = options.maxSteps ?? 8;
  const maxTokens = options.maxTokens ?? 1024;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const gate = new ConfirmationGate(options.classifyToolCall);
  const history: Message[] = [];
  let client: BedrockClientLike | undefined = options.client;
  let ConverseCommand: (new (input: unknown) => unknown) | undefined;

  async function converse(input: Record<string, unknown>): Promise<ConverseOutput> {
    if (!ConverseCommand) {
      const sdk = await import("@aws-sdk/client-bedrock-runtime");
      ConverseCommand = sdk.ConverseCommand as unknown as new (input: unknown) => unknown;
      client ??= new sdk.BedrockRuntimeClient({
        ...(options.region ? { region: options.region } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
      }) as BedrockClientLike;
    }
    return (await client!.send(new ConverseCommand(input))) as ConverseOutput;
  }

  /** Converse needs user and assistant messages to alternate, so text added
   *  after a user message (tool results) joins that message. */
  function addUserContent(content: ContentBlock[]) {
    const last = history.at(-1);
    if (last?.role === "user") last.content.push(...content);
    else history.push({ role: "user", content });
  }

  return {
    name: "bedrock",
    reset() {
      history.length = 0;
      gate.reset();
    },
    async turn(utterance: string, context?: BrainTurnContext): Promise<BrainTurnResult> {
      const session = await options.session();
      const tools = bedrockToolNames(session.tools);
      const toolConfig = { tools: [...tools].map(([name, tool]) => toolSpec(name, tool)) };

      gate.beginTurn();
      addUserContent([{ text: withTurnContext(utterance, context) }]);

      const trace: ToolCallTrace[] = [];
      let steps = 0;
      for (;;) {
        const outOfSteps = steps >= maxSteps;
        const response = await converse({
          modelId: model,
          system: [{ text: systemPrompt }],
          messages: history,
          inferenceConfig: { maxTokens },
          // Converse needs the tool definitions whenever the history has tool calls in it.
          ...(toolConfig.tools.length ? { toolConfig } : {}),
        });
        const content = response.output?.message?.content ?? [];
        const toolUses = content.filter((block) => block.toolUse).map((block) => block.toolUse!);

        if (toolUses.length === 0 || outOfSteps) {
          // Out of steps, any further tool calls are dropped: keeping them
          // without results would leave the history invalid for next turn.
          const reply = textOf(content) || (outOfSteps ? STEP_LIMIT_REPLY : EMPTY_REPLY);
          history.push({ role: "assistant", content: outOfSteps || !textOf(content) ? [{ text: reply }] : content });
          return { reply, trace, awaitingConfirmation: gate.awaiting };
        }
        history.push({ role: "assistant", content });

        const results: ContentBlock[] = [];
        for (const use of toolUses) {
          const tool = tools.get(use.name);
          const args = (use.input ?? {}) as Record<string, unknown>;
          if (!tool) {
            results.push(errorResult(use.toolUseId, `There is no tool named ${use.name}.`));
            continue;
          }
          if (steps >= maxSteps) {
            results.push(errorResult(use.toolUseId, "Not run: the tool call limit for this request was reached."));
            continue;
          }
          steps++;
          if (gate.check(tool, tool.name, args) === "hold") {
            results.push(errorResult(use.toolUseId, heldCallMessage(use.name)));
            continue;
          }
          try {
            const call = await callTool(session, tool.name, args);
            trace.push(call);
            results.push(toolResultBlock(use.toolUseId, call));
          } catch (err) {
            // The server answered with a JSON-RPC error (unknown tool, bad
            // arguments...): the model can correct itself. Anything else (the
            // connection) is the host's to handle, e.g. by relinking.
            if (!(err instanceof ProtocolError)) throw err;
            trace.push({ tool: tool.name, args, text: err.message, isError: true, ms: 0 });
            results.push(errorResult(use.toolUseId, `The tool failed: ${err.message}`));
          }
        }
        if (steps >= maxSteps) {
          results.push({
            text: `That was the last of the ${maxSteps} tool calls allowed for this request. Answer now with what you know, without calling tools, and say if something is still unknown.`,
          });
        }
        addUserContent(results);
      }
    },
  };
}
