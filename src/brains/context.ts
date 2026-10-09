import type { BrainTurnContext } from "./types.js";

/** The utterance as the model sees it: any turn context first, labelled as
 *  coming from the app so the model doesn't mistake it for the user's words. */
export function withTurnContext(utterance: string, context?: BrainTurnContext): string {
  if (!context || Object.keys(context).length === 0) return utterance;
  return `[Context from the app for this turn, not said by the user: ${JSON.stringify(context)}]\n${utterance}`;
}
