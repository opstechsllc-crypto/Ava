import type { SessionSourcePredicateFacts } from "./session-source-authority.js";
import type { SqliteExpectedSessionTranscriptTurnResult } from "./session-turn.types.js";

export type SessionColdMutationResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
  sessionKey?: string;
  turnRebound?: SqliteExpectedSessionTranscriptTurnResult;
  refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
};
