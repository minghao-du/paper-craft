# EPIC finalization audit

Use this branch when Conductor dispatches a post-merge EPIC audit; other creation,
optimization and review uses retain their own workflow.

1. Read the verified integrated SHA, actual per-PR changes, Worker results and evidence.
   Trace changed rules, scripts, helpers, config/schema, profiles, environments and
   input/output contracts through their real callers and consumers. Expand for global
   dependencies or opaque dynamic includes, reporting uncertainty. Exclude unrelated
   components with reasons; a title or filename suffix alone is insufficient evidence.
   **Done:** Every included dependency has an impact reason and uncertainty is explicit.
2. Apply this skill's audit and Smoke Execution Contract to that scope. Distinguish
   inspected components from the smoke targets actually executed through the production
   entry. A dry run does not establish execution success. Preserve source, configuration
   and existing scientific outputs; write smoke outputs, logs and metadata only to an
   isolated validation root outside the source checkout. Reuse artifacts only with
   verified code, input, parameter and environment identity.
   **Done:** Required checks have commands and evidence, or blocking explanations of why
   they could not run. No full production DAG is required merely to check unrelated work.
3. Return a structured receipt using the contract in
   [Conductor finalization](../pc-conductor/finalization.md). Include evaluated PR/SHA
   identities, scope reasons, commands, artifacts, blocking defects, nonblocking advice
   and unperformed checks in the appropriate fields. Include the named code roots,
   affected directory/script mapping, callers and dependent stages in that scope
   evidence for the research-state writer. Technical defects return to the
   existing EPIC/Worker/PR repair flow; this task audits without editing workflow code.
   **Done:** Status is `blocked` for required evidence gaps or blocking defects;
   `completed` accounts for all required checks, with limitations and advice explicit.
