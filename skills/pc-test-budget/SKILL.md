---
name: pc-test-budget
description: Test budget — apply before adding or modifying tests during feature work, bug fixes, refactoring, or test maintenance. Require concrete regression value and a complete per-test execution within 120 seconds.
---

# Test budget

Keep the smallest set of tests that detects consequential failures. Apply both gates below to every test added or modified in the current task. Leave unrelated historical tests alone unless the user requests an audit or cleanup.

## 1. Earn the test

Inspect the changed behavior and relevant existing tests. For each proposed test, identify:

- The specific behavior that could fail and a plausible triggering input or condition.
- The consequence of that failure for a user, business rule, data integrity, or an external contract.
- The coverage gap: why an existing test or a cheaper check does not already detect it.

Write the test only when all three have concrete answers. Prefer extending an existing case over adding overlapping coverage. A real bug regression, important business rule, or meaningful boundary condition can earn a test; test counts and coverage percentages alone cannot.

Assertions must distinguish correct behavior from the identified failure, using an expectation independent of the implementation. Omit tests that merely reproduce the implementation, check trivial assignments or constants without a consequential contract, or assert behavior already covered. For cosmetic or otherwise low-impact changes, an appropriate inspection, type check, or existing test may be sufficient.

Done when each candidate has a concrete justification or is omitted. Keep this reasoning brief; do not create a separate justification document or approval step.

## 2. Fit the runtime budget

**A complete execution of one test must finish within 120 seconds.** This is a ceiling, not a target, and applies regardless of test type or importance.

Count elapsed wall-clock time for the test's required setup, fixture or data creation, service startup, waits, execution, and teardown. Include required shared setup when assessing the test in isolation; do not amortize or pre-run that work to conceal its cost. Dependency installation and unrelated project builds are outside the test budget unless the test itself requires them as part of its execution.

- Before writing, use relevant timings or the actual work involved to assess feasibility. If it is expected to exceed the limit, redesign first.
- Prefer smaller representative inputs, local fixtures, controlled clocks, or a narrower boundary while preserving the failure the test is meant to catch. Use mocks only when they preserve that purpose; a mock cannot establish that the replaced integration works.
- For unknown runtime, use a bounded first execution. Enforce a 120-second deadline around the complete lifecycle, including child work; a runner timeout that excludes fixtures or teardown is insufficient. Use an isolated invocation or an outer timeout when needed. At the deadline, terminate the run and its owned child work, then clean up resources. A timed-out run fails this gate even if cleanup takes additional time.
- Validate added or modified tests with a bounded run and record observed timing. Label estimates and unmeasured tests honestly; never claim the budget was verified without measurement. One passing measurement does not guarantee identical timing on every machine.

Do not evade the ceiling by increasing timeouts, retrying until a fast run appears, moving required work outside the timer, or splitting one slow scenario into dependent named tests. Independently useful smaller tests are acceptable when each passes both gates.

Done when every added or modified test has passed both gates, or its unresolved validation status is explicitly reported. If a necessary scenario cannot fit, omit that new test, explain the remaining risk, and identify any meaningful faster check. For a pre-existing test being modified, preserve existing coverage and report the conflict rather than silently deleting or disabling it. Importance alone does not waive the limit.

## Report

Briefly state which behavior the retained tests protect, what validation ran and its timing, and any meaningful coverage gap. If no new test earned its place, say so. Do not add tests merely to demonstrate compliance with this skill.
