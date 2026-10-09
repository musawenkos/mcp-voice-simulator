import { ProtocolError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createBedrockBrain, DEFAULT_BEDROCK_MODEL, type BedrockBrainOptions } from "../src/brains/bedrock.js";
import type { McpSession, McpTool } from "../src/mcp.js";

// --- A fake MCP session: records calls, answers from a handler -------------

type Handler = (name: string, args: Record<string, unknown>) => unknown;

function fakeSession(tools: McpTool[], handler: Handler = (name) => ({ content: [{ type: "text", text: `${name} ok` }] })) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const session = {
    tools,
    ui: false,
    client: {
      async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
        calls.push({ name, args });
        return handler(name, args);
      },
    },
  } as unknown as McpSession;
  return { session, calls };
}

// --- A fake Bedrock client: answers Converse calls from a script ----------

type Block = Record<string, unknown>;
type Converse = { modelId: string; system: Block[]; messages: Array<{ role: string; content: Block[] }>; toolConfig?: { tools: Array<{ toolSpec: any }> }; inferenceConfig: { maxTokens: number } };

const text = (t: string): Block[] => [{ text: t }];
const use = (id: string, name: string, input: Record<string, unknown> = {}): Block => ({ toolUse: { toolUseId: id, name, input } });

function fakeBedrock(script: Array<Block[] | ((input: Converse) => Block[])>) {
  const requests: Converse[] = [];
  const client = {
    async send(command: { input: Converse }) {
      // Copy: the brain keeps appending to the same history array.
      requests.push(structuredClone(command.input));
      const next = script.shift();
      if (!next) throw new Error("fake Bedrock: no more scripted responses");
      const content = typeof next === "function" ? next(command.input) : next;
      return { output: { message: { role: "assistant", content } }, stopReason: content.some((b) => b.toolUse) ? "tool_use" : "end_turn" };
    },
  };
  return { client, requests };
}

const readTool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: { corridor: { type: "string" } } },
  annotations: { readOnlyHint: true },
  ...extra,
});
const writeTool = (name: string, properties: Record<string, unknown> = { id: { type: "string" } }): McpTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties },
  annotations: { readOnlyHint: false },
});

function brainWith(session: McpSession, client: { send(c: unknown): Promise<unknown> }, extra: Partial<BedrockBrainOptions> = {}) {
  return createBedrockBrain({ session: async () => session, client, ...extra });
}

/** Every request must alternate user/assistant and answer each toolUse in the next message, or Converse rejects it. */
function expectValidHistory(messages: Converse["messages"]) {
  messages.forEach((message, i) => {
    expect(message.role).toBe(i % 2 === 0 ? "user" : "assistant");
    expect(message.content.length).toBeGreaterThan(0);
    const ids = message.content.filter((b) => b.toolUse).map((b) => (b.toolUse as any).toolUseId);
    if (ids.length) {
      const answered = messages[i + 1]?.content.filter((b) => b.toolResult).map((b) => (b.toolResult as any).toolUseId);
      expect(answered).toEqual(ids);
    }
  });
}

describe("createBedrockBrain", () => {
  it("sends the MCP tools as Bedrock tool specs with the default model and prompt", async () => {
    const { session } = fakeSession([
      readTool("find_surveys"),
      { name: "tasks.list", inputSchema: undefined }, // dotted name, no description, no schema
    ]);
    const { client, requests } = fakeBedrock([text("Hello.")]);
    const result = await brainWith(session, client).turn("hi");

    expect(result.reply).toBe("Hello.");
    const [request] = requests;
    expect(request.modelId).toBe(DEFAULT_BEDROCK_MODEL);
    expect(request.system[0].text).toMatch(/voice assistant/);
    expect(request.inferenceConfig.maxTokens).toBe(1024);
    expect(request.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
    expect(request.toolConfig!.tools.map((t) => t.toolSpec)).toEqual([
      {
        name: "find_surveys",
        description: "find_surveys description",
        inputSchema: { json: { type: "object", properties: { corridor: { type: "string" } } } },
      },
      { name: "tasks_list", description: "tasks.list", inputSchema: { json: { type: "object", properties: {} } } },
    ]);
  });

  it("maps a sanitised tool name back to the MCP name when calling", async () => {
    const { session, calls } = fakeSession([readTool("tasks.list")]);
    const { client } = fakeBedrock([[use("t1", "tasks_list")], text("Done.")]);
    await brainWith(session, client).turn("list tasks");
    expect(calls.map((c) => c.name)).toEqual(["tasks.list"]);
  });

  it("uses the given model, system prompt and token limit", async () => {
    const { session } = fakeSession([]);
    const { client, requests } = fakeBedrock([text("ok")]);
    await brainWith(session, client, { model: "global.anthropic.claude-haiku-4-5-20251001-v1:0", systemPrompt: "Be brief.", maxTokens: 300 }).turn("hi");
    expect(requests[0].modelId).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(requests[0].system).toEqual([{ text: "Be brief." }]);
    expect(requests[0].inferenceConfig.maxTokens).toBe(300);
    expect(requests[0].toolConfig).toBeUndefined(); // Converse rejects an empty tool list
  });

  it("runs a multi-step chain, including parallel calls, and keeps full results in the trace", async () => {
    const { session, calls } = fakeSession(
      [readTool("find_surveys"), readTool("compare_surveys"), readTool("find_worst_stretches")],
      (name) => ({ content: [{ type: "text", text: `${name} result` }], structuredContent: { tool: name } }),
    );
    const { client, requests } = fakeBedrock([
      [{ text: "Let me look." }, use("a", "find_surveys", { corridor: "N1" })],
      [use("b", "compare_surveys", { corridor: "N1" }), use("c", "find_worst_stretches", { corridor: "N1" })],
      text("Potholes rose on the N1."),
    ]);
    const result = await brainWith(session, client).turn("What changed on the N1?");

    expect(result.reply).toBe("Potholes rose on the N1.");
    expect(calls.map((c) => c.name)).toEqual(["find_surveys", "compare_surveys", "find_worst_stretches"]);
    expect(result.trace.map((t) => t.tool)).toEqual(["find_surveys", "compare_surveys", "find_worst_stretches"]);
    expect(result.trace[1].result?.structuredContent).toEqual({ tool: "compare_surveys" });
    expect(result.trace[1].args).toEqual({ corridor: "N1" });

    const last = requests.at(-1)!.messages;
    expect(last.at(-1)!.content).toEqual([
      { toolResult: { toolUseId: "b", content: [{ text: "compare_surveys result" }], status: "success" } },
      { toolResult: { toolUseId: "c", content: [{ text: "find_worst_stretches result" }], status: "success" } },
    ]);
    expectValidHistory(last);
  });

  it("keeps the conversation across turns until reset", async () => {
    const { session } = fakeSession([]);
    const { client, requests } = fakeBedrock([text("One."), text("Two."), text("Fresh.")]);
    const brain = brainWith(session, client);
    await brain.turn("first");
    await brain.turn("second");
    expect(requests[1].messages.map((m) => m.content[0].text)).toEqual(["first", "One.", "second"]);
    brain.reset!();
    await brain.turn("third");
    expect(requests[2].messages).toEqual([{ role: "user", content: [{ text: "third" }] }]);
  });

  it("passes turn context to the model, labelled as coming from the app", async () => {
    const { session } = fakeSession([]);
    const { client, requests } = fakeBedrock([text("ok")]);
    await brainWith(session, client).turn("log a pothole here", { gps: { latitude: -25.5, longitude: 28.1 } });
    const said = requests[0].messages[0].content[0].text as string;
    expect(said).toMatch(/^\[Context from the app for this turn, not said by the user: \{"gps":\{"latitude":-25.5,"longitude":28.1\}\}\]\n/);
    expect(said.endsWith("log a pothole here")).toBe(true);
  });

  describe("step limit", () => {
    it("stops calling tools after maxSteps and makes the model answer with what it has", async () => {
      const { session, calls } = fakeSession([readTool("lookup")]);
      const { client, requests } = fakeBedrock([
        [use("1", "lookup")],
        [use("2", "lookup")],
        [use("3", "lookup")],
        text("Here is what I found so far."),
      ]);
      const result = await brainWith(session, client, { maxSteps: 3 }).turn("dig deep");

      expect(calls).toHaveLength(3);
      expect(result.reply).toBe("Here is what I found so far.");
      const finalRequest = requests.at(-1)!;
      const note = finalRequest.messages.at(-1)!.content.at(-1)!;
      expect(note.text).toMatch(/last of the 3 tool calls/);
      expectValidHistory(finalRequest.messages);
    });

    it("counts parallel calls one by one and refuses the ones past the limit", async () => {
      const { session, calls } = fakeSession([readTool("lookup")]);
      const { client, requests } = fakeBedrock([[use("1", "lookup"), use("2", "lookup"), use("3", "lookup")], text("Partial answer.")]);
      await brainWith(session, client, { maxSteps: 2 }).turn("go");

      expect(calls).toHaveLength(2);
      const results = requests[1].messages.at(-1)!.content;
      expect(results[2]).toEqual({
        toolResult: { toolUseId: "3", content: [{ text: "Not run: the tool call limit for this request was reached." }], status: "error" },
      });
    });

    it("drops tool calls the model still makes after the limit, leaving a valid history", async () => {
      const { session, calls } = fakeSession([readTool("lookup")]);
      const { client, requests } = fakeBedrock([[use("1", "lookup")], [use("2", "lookup")], text("Next turn.")]);
      const brain = brainWith(session, client, { maxSteps: 1 });
      const result = await brain.turn("go");

      expect(calls).toHaveLength(1);
      expect(result.reply).toBe("Sorry, that took too many steps. Could you say that again?");
      await brain.turn("again");
      expectValidHistory(requests.at(-1)!.messages);
    });
  });

  describe("tool errors", () => {
    it("reports an isError result to the model as an error", async () => {
      const { session } = fakeSession([readTool("lookup")], () => ({ content: [{ type: "text", text: "No survey for 2031." }], isError: true }));
      const { client, requests } = fakeBedrock([[use("1", "lookup")], text("There's no 2031 survey.")]);
      const result = await brainWith(session, client).turn("2031?");

      expect(result.trace[0].isError).toBe(true);
      expect(requests[1].messages.at(-1)!.content[0]).toEqual({
        toolResult: { toolUseId: "1", content: [{ text: "No survey for 2031." }], status: "error" },
      });
      expect(result.reply).toBe("There's no 2031 survey.");
    });

    it("feeds a JSON-RPC error back to the model so it can correct itself", async () => {
      const { session } = fakeSession([readTool("lookup")], () => {
        throw new ProtocolError(-32602, "Invalid params: corridor is required");
      });
      const { client, requests } = fakeBedrock([[use("1", "lookup")], text("Which corridor?")]);
      const result = await brainWith(session, client).turn("look it up");

      expect(result.reply).toBe("Which corridor?");
      expect(result.trace[0]).toMatchObject({ tool: "lookup", isError: true });
      const sent = requests[1].messages.at(-1)!.content[0].toolResult as any;
      expect(sent.status).toBe("error");
      expect(sent.content[0].text).toMatch(/corridor is required/);
    });

    it("lets connection failures through, so the host can relink", async () => {
      const { session } = fakeSession([readTool("lookup")], () => {
        throw new TypeError("fetch failed");
      });
      const { client } = fakeBedrock([[use("1", "lookup")]]);
      await expect(brainWith(session, client).turn("look it up")).rejects.toThrow("fetch failed");
    });

    it("answers a call to a tool that doesn't exist with an error", async () => {
      const { session, calls } = fakeSession([readTool("lookup")]);
      const { client, requests } = fakeBedrock([[use("1", "made_up")], text("I can't do that.")]);
      await brainWith(session, client).turn("?");
      expect(calls).toHaveLength(0);
      expect((requests[1].messages.at(-1)!.content[0].toolResult as any).status).toBe("error");
    });

    it("sends structured content when a tool returns no text, since Bedrock rejects empty text", async () => {
      const { session } = fakeSession([readTool("lookup")], () => ({ content: [], structuredContent: { count: 3 } }));
      const { client, requests } = fakeBedrock([[use("1", "lookup")], text("Three.")]);
      await brainWith(session, client).turn("how many?");
      expect((requests[1].messages.at(-1)!.content[0].toolResult as any).content).toEqual([{ json: { count: 3 } }]);
    });
  });

  describe("confirming mutating calls", () => {
    it("holds a write until the user's next turn, then runs exactly that call", async () => {
      const { session, calls } = fakeSession([writeTool("void_observation")]);
      const { client, requests } = fakeBedrock([
        [use("1", "void_observation", { id: "obs-7" })],
        text("I'll void observation 7. Shall I go ahead?"),
        [use("2", "void_observation", { id: "obs-7" })],
        text("Voided."),
      ]);
      const brain = brainWith(session, client);

      const first = await brain.turn("void my last observation");
      expect(calls).toHaveLength(0);
      expect(first.trace).toHaveLength(0);
      expect(first.awaitingConfirmation).toBe(true);
      const held = requests[1].messages.at(-1)!.content[0].toolResult as any;
      expect(held.status).toBe("error");
      expect(held.content[0].text).toMatch(/needs the user's go-ahead/);

      const second = await brain.turn("yes");
      expect(calls).toEqual([{ name: "void_observation", args: { id: "obs-7" } }]);
      expect(second.awaitingConfirmation).toBe(false);
      expect(second.reply).toBe("Voided.");
    });

    it("holds again when the confirming call differs from what was read back", async () => {
      const { session, calls } = fakeSession([writeTool("void_observation")]);
      const { client } = fakeBedrock([
        [use("1", "void_observation", { id: "obs-7" })],
        text("Void 7?"),
        [use("2", "void_observation", { id: "obs-8" })],
        text("Void 8 instead?"),
      ]);
      const brain = brainWith(session, client);
      await brain.turn("void it");
      const second = await brain.turn("yes");
      expect(calls).toHaveLength(0);
      expect(second.awaitingConfirmation).toBe(true);
    });

    it("never runs a write proposed and confirmed within the same turn", async () => {
      const { session, calls } = fakeSession([writeTool("void_observation")]);
      const { client } = fakeBedrock([
        [use("1", "void_observation", { id: "obs-7" })],
        [use("2", "void_observation", { id: "obs-7" })],
        text("Please confirm."),
      ]);
      await brainWith(session, client).turn("void observation 7, I confirm");
      expect(calls).toHaveLength(0);
    });

    it("treats a confirm-parameter tool's preview as the read-back, so yes runs it next turn", async () => {
      const logTool = writeTool("log_observation", { degree: { type: "integer" }, confirm: { type: "boolean" } });
      const { session, calls } = fakeSession([logTool]);
      const { client } = fakeBedrock([
        [use("1", "log_observation", { degree: 3 })],
        text("Crack, degree 3. Shall I log it?"),
        [use("2", "log_observation", { degree: 3, confirm: true })],
        text("Saved."),
      ]);
      const brain = brainWith(session, client);

      await brain.turn("log a crack, degree 3");
      expect(calls).toEqual([{ name: "log_observation", args: { degree: 3 } }]);
      await brain.turn("yes");
      expect(calls[1]).toEqual({ name: "log_observation", args: { degree: 3, confirm: true } });
    });

    it("runs read-only tools freely and lets the host exempt tools", async () => {
      const { session, calls } = fakeSession([readTool("lookup"), writeTool("attach_photo")]);
      const { client } = fakeBedrock([[use("1", "lookup"), use("2", "attach_photo", { id: "p1" })], text("Attached.")]);
      await brainWith(session, client, { classifyToolCall: (tool) => (tool?.name === "attach_photo" ? "run" : undefined) }).turn(
        "attach the photo",
      );
      expect(calls.map((c) => c.name)).toEqual(["lookup", "attach_photo"]);
    });
  });
});
