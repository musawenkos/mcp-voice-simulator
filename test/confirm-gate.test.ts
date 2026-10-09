import { describe, expect, it } from "vitest";

import { ConfirmationGate, defaultClassifyToolCall } from "../src/brains/confirm.js";
import type { McpTool } from "../src/mcp.js";

const tool = (properties: Record<string, unknown>, readOnlyHint?: boolean): McpTool => ({
  name: "t",
  inputSchema: { type: "object", properties },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

describe("defaultClassifyToolCall", () => {
  it("runs read-only tools", () => {
    expect(defaultClassifyToolCall(tool({}, true), {})).toBe("run");
  });

  it("needs confirming for tools that aren't marked read-only, or that the session doesn't know", () => {
    expect(defaultClassifyToolCall(tool({ id: {} }, false), { id: "1" })).toBe("confirm");
    expect(defaultClassifyToolCall(tool({ id: {} }), { id: "1" })).toBe("confirm");
    expect(defaultClassifyToolCall(undefined, {})).toBe("confirm");
  });

  it("treats confirm and dryRun parameters as preview/commit switches", () => {
    const withConfirm = tool({ confirm: {} }, false);
    expect(defaultClassifyToolCall(withConfirm, {})).toBe("preview");
    expect(defaultClassifyToolCall(withConfirm, { confirm: false })).toBe("preview");
    expect(defaultClassifyToolCall(withConfirm, { confirm: true })).toBe("confirm");

    const withDryRun = tool({ dryRun: {} }, false);
    expect(defaultClassifyToolCall(withDryRun, { dryRun: true })).toBe("preview");
    expect(defaultClassifyToolCall(withDryRun, {})).toBe("confirm");
  });
});

describe("ConfirmationGate", () => {
  const write = tool({ id: {}, note: {} }, false);

  it("matches the confirming call regardless of key order and null values", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    expect(gate.check(write, "t", { id: "1", note: null })).toBe("hold");
    gate.beginTurn();
    expect(gate.check(write, "t", { note: undefined, id: "1" })).toBe("run");
  });

  it("only lets a call through once per proposal", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    gate.check(write, "t", { id: "1" });
    gate.beginTurn();
    expect(gate.check(write, "t", { id: "1" })).toBe("run");
    expect(gate.check(write, "t", { id: "1" })).toBe("hold");
  });

  it("forgets proposals older than the previous turn", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    gate.check(write, "t", { id: "1" });
    gate.beginTurn(); // the user talked about something else
    gate.beginTurn();
    expect(gate.check(write, "t", { id: "1" })).toBe("hold");
  });

  it("tells different tools apart", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    gate.check(write, "a", { id: "1" });
    gate.beginTurn();
    expect(gate.check(write, "b", { id: "1" })).toBe("hold");
  });

  it("forgets everything on reset", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    gate.check(write, "t", { id: "1" });
    expect(gate.awaiting).toBe(true);
    gate.reset();
    expect(gate.awaiting).toBe(false);
    gate.beginTurn();
    expect(gate.check(write, "t", { id: "1" })).toBe("hold");
  });

  it("reports awaiting only for a held call, not for a preview", () => {
    const gate = new ConfirmationGate();
    gate.beginTurn();
    gate.check(tool({ confirm: {} }, false), "log", {});
    expect(gate.awaiting).toBe(false);
  });
});
