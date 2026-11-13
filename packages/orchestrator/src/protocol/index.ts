/**
 * Protocol entry: shared TaskInputEnvelope and CompactReport contracts.
 * Must not import lifecycle, workflow, or run-store.
 */
export {
  isObject,
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
