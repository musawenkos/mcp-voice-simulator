/**
 * A code-level guard so a model can't make a mutating tool call in the same
 * turn it decided to: the first attempt is held and the model is told to ask
 * the user; the identical call is let through only on the user's next turn.
 * The model still judges whether the user said yes, but a human turn always
 * sits between proposing a change and making it, and what runs is exactly
 * what was read back.
 *
 * Tools with the two-step shape this project's prompts already describe
 * (`confirm` or `dryRun` parameters) count their preview call as the read-back,
 * so the confirming call on the next turn runs without asking twice.
 */
import type { McpTool } from "../mcp.js";

/**
 * - `run`: no confirmation needed (read-only tools, or ones you exempt)
 * - `preview`: runs, and counts as the read-back for a `confirm` call next turn
 * - `confirm`: needs a matching preview or held attempt from the previous turn
 */
export type ToolCallKind = "run" | "preview" | "confirm";

export type ClassifyToolCall = (
  tool: McpTool | undefined,
  args: Record<string, unknown>,
) => ToolCallKind | undefined;

/** Parameters that say "preview" or "do it" rather than what to do, so they
 *  don't count when matching a confirming call to its read-back. */
const CONFIRM_PARAMS = ["confirm", "dryRun"];

function hasParam(tool: McpTool | undefined, name: string): boolean {
  const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(properties && Object.hasOwn(properties, name));
}

/** Read-only tools (`annotations.readOnlyHint`) run freely; anything else needs
 *  confirming, except preview calls of tools with `confirm`/`dryRun` parameters. */
export function defaultClassifyToolCall(tool: McpTool | undefined, args: Record<string, unknown>): ToolCallKind {
  if (tool?.annotations?.readOnlyHint === true) return "run";
  if (hasParam(tool, "confirm")) return args.confirm === true ? "confirm" : "preview";
  if (hasParam(tool, "dryRun")) return args.dryRun === true ? "preview" : "confirm";
  return "confirm";
}

/** JSON with sorted keys and without null/undefined values, so `{a:1,b:null}`
 *  and `{a:1}` (which mean the same to most tools) compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function callKey(name: string, args: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !CONFIRM_PARAMS.includes(k)));
  return `${name} ${canonical(rest)}`;
}

export function heldCallMessage(name: string): string {
  return (
    `Not run: ${name} changes data and needs the user's go-ahead first. ` +
    "Tell the user exactly what it will do and ask them to confirm. " +
    `If they agree in their next message, call ${name} again with exactly the same arguments.`
  );
}

export class ConfirmationGate {
  private turn = 0;
  /** Proposed call -> the turn it was proposed in. */
  private readonly proposed = new Map<string, number>();
  private heldThisTurn = false;

  constructor(private readonly classify: ClassifyToolCall = defaultClassifyToolCall) {}

  beginTurn(): void {
    this.turn++;
    this.heldThisTurn = false;
    // Only last turn's proposals can be confirmed now.
    for (const [key, turn] of this.proposed) if (turn < this.turn - 1) this.proposed.delete(key);
  }

  /** Whether to make this call now (`run`) or hold it for the user's yes (`hold`). */
  check(tool: McpTool | undefined, name: string, args: Record<string, unknown>): "run" | "hold" {
    const kind = this.classify(tool, args) ?? defaultClassifyToolCall(tool, args);
    if (kind === "run") return "run";
    const key = callKey(name, args);
    if (kind === "preview") {
      this.propose(key);
      return "run";
    }
    if (this.proposed.get(key) === this.turn - 1) {
      this.proposed.delete(key);
      return "run";
    }
    this.propose(key);
    this.heldThisTurn = true;
    return "hold";
  }

  /** Whether this turn held a call that now waits for the user's yes. (A
   *  preview may instead have found something missing to ask about, so it
   *  doesn't count; the reply's own wording covers that case.) */
  get awaiting(): boolean {
    return this.heldThisTurn;
  }

  reset(): void {
    this.proposed.clear();
    this.heldThisTurn = false;
  }

  private propose(key: string): void {
    this.proposed.set(key, this.turn);
  }
}
