/**
 * Protocol entry: shared TaskInputEnvelope and CompactReport contracts.
 * Independent of run-operations, workflow-policy, and run-store.
 */
export {
  isObject,
  isNonEmptyString,
  ProtocolError,
  type JsonObject,
  type ProtocolErrorOptions,
} from "./errors.js";
export {
  assertTaskInputEnvelope,
  EnvelopeValidationError,
  parseTaskInputEnvelope,
  validateTaskInputEnvelope,
  type TaskInputEnvelope,
} from "./envelope.js";
export {
  parseReportInput,
  type CompactReport,
  type ExecutionStatus,
} from "./report.js";
