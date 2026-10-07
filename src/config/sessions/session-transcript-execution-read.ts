import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  AgentDatabaseExecutionScope,
  AgentDatabaseGenerationClaim,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import type { SessionTranscriptExecutionReadResult } from "./session-transcript-execution-read.types.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

export type PreparedSessionTranscriptReads = Pick<
  SessionHistoryWorkerDatabase,
  | "readRawDelta"
  | "readVisibleDelta"
  | "readSessionMemoryCapture"
  | "readColdMetadata"
  | "readAnchors"
  | "readWatermark"
>;

/** A prepared writer lends its connection for reads; this never prepares a replacement writer. */
export function createPreparedSessionTranscriptReads(params: {
  execution: OpenClawAgentDatabaseExecution;
  claim: AgentDatabaseGenerationClaim;
  expectedIdentity: DatabaseFileIdentity;
  assertCurrent: () => void;
}): PreparedSessionTranscriptReads {
  const { execution, claim, expectedIdentity } = params;
  const assertCurrent = () => {
    params.assertCurrent();
    claim.assertCurrent();
    assertExistingDatabaseIdentity(
      execution.path,
      expectedIdentity.key,
      expectedIdentity.birthtime,
    );
    if (`file:${claim.identity}` !== expectedIdentity.key) {
      throw new Error("Transcript reader belongs to another prepared database generation");
    }
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Prepared transcript read authority expired");
          }
        }, binding.attachment),
      });
    },
  };
  const read = async <T>(
    operation: (
      worker: AgentDatabaseExecutionScope,
    ) => Promise<SessionTranscriptExecutionReadResult<T>>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    assertCurrent();
    return await runOpenClawAgentWriteAdmission(
      execution,
      async (_identity, assertTarget) => {
        assertCurrent();
        const result = await execution.runExisting(source, operation);
        signal?.throwIfAborted();
        assertTarget();
        assertCurrent();
        if (!result) {
          throw new Error("Prepared transcript reader lost its captured database");
        }
        if (!result.ok) {
          throw decodeSessionTranscriptWorkerReadError(result.error);
        }
        return result.value;
      },
      true,
      undefined,
      signal,
    );
  };
  return {
    readWatermark: (input) =>
      read((worker) =>
        worker.execute({
          type: "session.transcript.watermark.read",
          input: { ...input, expectedIdentity },
        }),
      ),
    readRawDelta: (input, signal) =>
      read(
        (worker) =>
          worker.execute(
            { type: "session.transcript.rawDelta.read", input: { ...input, expectedIdentity } },
            { signal },
          ),
        signal,
      ),
    readVisibleDelta: (input, signal) =>
      read(
        (worker) =>
          worker.execute(
            { type: "session.transcript.visibleDelta.read", input: { ...input, expectedIdentity } },
            { signal },
          ),
        signal,
      ),
    readSessionMemoryCapture: (input, signal) =>
      read(
        (worker) =>
          worker.execute(
            {
              type: "session.transcript.memoryCapture.read",
              input: { ...input, expectedIdentity },
            },
            { signal },
          ),
        signal,
      ),
    readAnchors: (input, signal) =>
      read(
        (worker) =>
          worker.execute(
            { type: "session.transcript.anchors.read", input: { ...input, expectedIdentity } },
            { signal },
          ),
        signal,
      ),
    readColdMetadata: async (input) => ({
      kind: "cold-metadata",
      archive: await read((worker) =>
        worker.execute({
          type: "session.transcript.coldMetadata.read",
          input: { sessionId: input.sessionId, expectedIdentity },
        }),
      ),
    }),
  };
}
