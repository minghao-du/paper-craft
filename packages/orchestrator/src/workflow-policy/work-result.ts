import { isObject, type CompactReport } from "../protocol/index.js";
import { isValidCommitSha } from "../../../workspace/src/git.js";
import type { WorkflowStage } from "./types.js";
import { isNonEmptyString } from "./evidence.js";

const inFlightOutcomes = new Set(["submitted", "pending", "running", "in_flight"]);

function hasVerifiedJob(job: unknown): boolean {
  if (!isObject(job) || job.status !== "completed" || !isNonEmptyString(job.job_id)) return false;
  return (job.exit_code === 0 || job.exit_code === "0" || job.exit_code === "0:0")
    && Array.isArray(job.checked_artifacts)
    && job.checked_artifacts.length > 0
    && job.checked_artifacts.every(isNonEmptyString);
}

/** Evidence required to settle a successful implementation delivery. Other conclusions route normally. */
export function missingWorkEvidence(stage: WorkflowStage, report: CompactReport): string[] {
  const result = report.result;
  if (stage.logical_task !== "issue_work" || report.execution_status !== "succeeded"
      || result.outcome === "rework_needed" || result.outcome === "out_of_scope") return [];

  const missing: string[] = [];
  if (typeof result.outcome === "string" && inFlightOutcomes.has(result.outcome)) missing.push("terminal_outcome");
  if (!isNonEmptyString(result.commit) || !isValidCommitSha(result.commit)) missing.push("commit");
  const gates = result.quality_gates;
  if (gates !== "passed" && !(isObject(gates) && gates.status === "passed")) missing.push("quality_gates");
  if (result.self_review !== "completed") missing.push("self_review");
  const compute = result.external_compute;
  if (compute !== "none") {
    const jobs = Array.isArray(compute) ? compute : [compute];
    if (!jobs.length || !jobs.every(hasVerifiedJob)) missing.push("external_compute");
  }
  return missing;
}
