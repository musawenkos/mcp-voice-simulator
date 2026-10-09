import type { ToolCallTrace } from "../mcp.js";

export interface BrainTurnResult {
  reply: string;
  trace: ToolCallTrace[];
  /** Set by brains that know a mutating call is waiting for the user's yes,
   *  so the host can offer Confirm/Cancel without guessing from the reply. */
  awaitingConfirmation?: boolean;
}

/** Facts the app or device knows at the time of an utterance (location, a
 *  just-uploaded file's id, the screen in view), as plain JSON. They are not
 *  words the user said; brains pass them to the model marked as such. */
export type BrainTurnContext = Record<string, unknown>;

/** Something that turns one utterance into tool calls plus a spoken reply.
 *  Write your own for your server's specific tools (see examples/), or use
 *  one of the built-in LLM-driven brains, which need no per-server tuning
 *  since they pick tools from whatever tools/list returns. */
export interface Brain {
  readonly name: string;
  turn(utterance: string, context?: BrainTurnContext): Promise<BrainTurnResult>;
  /** Clear any conversation state. Optional — stateless brains don't need it. */
  reset?(): Promise<void> | void;
}
