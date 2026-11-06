# Post-closure pipeline audit

Use this guide for post-merge or release pipeline auditing; other creation, optimization, and review uses retain their own workflow.

1. **Trace integrated changes:** Read the verified integrated SHA, actual pull request changes, and execution evidence. Trace changed rules, scripts, helpers, config/schema, profiles, environments, and input/output contracts through their real callers and consumers. Expand for global dependencies or dynamic includes, reporting uncertainty. Exclude unrelated components with reasons; a title or filename suffix alone is insufficient evidence.
   **Done:** Every included dependency has an impact reason and uncertainty is explicit.

2. **Execute smoke validation in isolation:** Apply the main skill's audit standards and the Smoke Execution Contract to that scope. Distinguish inspected components from smoke targets actually executed through the production entry. A dry-run does not establish execution success. Preserve source, configuration, and existing scientific outputs; write smoke outputs, logs, and metadata only to an isolated validation root outside the source checkout. Reuse artifacts only with verified code, input, parameter, and environment identity.
   **Done:** Required checks have commands and evidence, or blocking explanations of why they could not run. No full production DAG is required merely to check unrelated work.

3. **Produce structured audit report:** Record findings with evaluated `head`, `status` (`completed` or `blocked`), `evidence`, `blockers`, `scope`, `checks`, `artifacts`, and `limitations`. Include evaluated PR/SHA identities, scope reasons, commands, artifacts, blocking defects, nonblocking advice, and unperformed checks. Include the named code roots, affected directory/script mapping, callers, and dependent stages in the scope evidence for research records.
   **Done:** Status is `blocked` for required evidence gaps or blocking defects; `completed` accounts for all required checks, with limitations and advice explicit.
