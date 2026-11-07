# Test Infrastructure & 4-Tier E2E Testing Framework

## 1. Test Philosophy & Design Principles

The `paper-craft` test architecture ensures that architectural refactoring—including Stage-Provider Decoupling, Task Input Envelope contextualization, Skill Kernel-Wrapper execution, and the Unified Receipt Contract—is thoroughly verified through automated, reproducible test suites.

### Core Testing Invariants
1. **Opaque-Box & Requirement-Driven**: Tests interact exclusively with external interfaces, CLI entry points, file system artifacts, and well-defined JSON contracts. Test expectations are derived directly from `ORIGINAL_REQUEST.md` (R1–R5) and `PROJECT.md`.
2. **Progressive Testability**: Tests verify capabilities against implemented milestones (M1 baseline and contract interfaces) and enforce that decoupled providers and kernel scripts adhere to unambiguous contract boundaries.
3. **Execution Isolation & Hermetic State**: Every test executes in an isolated temporary directory created on demand. No shared state or persistent artifacts pollute the repository worktree.
4. **120-Second Per-Test Budget**: Tests are bounded, fast, and deterministic. All test suites complete well under the 120-second budget requirement.
5. **No Facade Tests**: Tests execute actual CLI processes, perform atomic file I/O, validate strict schema constraints, and verify real exit codes and error messages.

---

## 2. 4-Tier E2E Testing Methodology

The test suite is structured around a 4-Tier verification pyramid:

```
                  ┌────────────────────────────────────────┐
                  │    Tier 4: Real-World Scenarios        │
                  │  Full E2E Dispatch & Script Execution  │
                  ├────────────────────────────────────────┤
                  │       Tier 3: Combinations             │
                  │  State Machine + Envelope + Providers  │
                  ├────────────────────────────────────────┤
                  │   Tier 2: Boundary & Corner Cases      │
                  │   Corrupted JSON, Types, Permissions   │
                  ├────────────────────────────────────────┤
                  │      Tier 1: Feature Coverage          │
                  │  Envelope · Providers · Kernel · Cont. │
                  └────────────────────────────────────────┘
```

### Tier 1: Core Feature Coverage (>= 5 tests per feature)
Covers all primary happy paths and core specifications for each architectural feature:

- **Feature 1: Task Input Envelope (`envelope.py` / CLI)**
  - T1.1.1: Complete envelope creation with all required and optional fields.
  - T1.1.2: Atomic file write semantics (`save_envelope`) producing valid `<step>-input.json`.
  - T1.1.3: Schema validation accepting fully conformant envelope dictionaries.
  - T1.1.4: Schema validation rejecting missing required top-level keys (`task`, `provider`, `environment`, etc.).
  - T1.1.5: Budget metadata serialization (`delivery_attempts_used`/`max`, `replans_used`/`max`).
  - T1.1.6: State context inheritance (`--from-state`) resolving root issue, workdir, base branch, and receipts.

- **Feature 2: Stage-Provider Decoupling**
  - T1.2.1: Envelope accepts and validates `provider.type = "skill"` with skill target.
  - T1.2.2: Envelope accepts and validates `provider.type = "script"` with script path target.
  - T1.2.3: Rejection of invalid provider types (e.g. `"plugin"`, `"service"`, or empty strings).
  - T1.2.4: Preservation of provider arguments array (`args: ["--flag", "value"]`).
  - T1.2.5: Logical stage independence: identical stage (`workspace_prepare` or `issue_plan`) can target either skill or script provider without structural changes.

- **Feature 3: Skill Kernel-Wrapper Pattern**
  - T1.3.1: Kernel script invocation driven by `--input-envelope <path>`.
  - T1.3.2: Kernel consumption of envelope input payload (objective, scope, working directory).
  - T1.3.3: Kernel generation of structured Markdown receipt at contract `receipt_path`.
  - T1.3.4: Kernel error handling and exit code propagation when envelope is missing or invalid.
  - T1.3.5: Wrapper equivalence: deterministic kernel script outputs conform to subagent receipt expectations.

- **Feature 4: Unified Receipt Contract**
  - T1.4.1: Compact JSON report stdout conformance: `{ execution_status, result, receipt_path, summary }`.
  - T1.4.2: Enforce allowed `execution_status` values (`"succeeded"`, `"blocked"`, `"failed"`).
  - T1.4.3: Physical receipt file existence and non-emptiness at specified path.
  - T1.4.4: Predecessor receipt chaining: successive envelopes record predecessor receipt paths.
  - T1.4.5: Compact report schema validation and structured result verification.

### Tier 2: Boundary & Corner Cases
Exercises edge conditions, malicious inputs, and system failure modes:
- **Corrupted & Malformed JSON**: Truncated files, syntax errors, non-object JSON roots.
- **Data Type & Range Boundary Violations**: Negative integers, boolean flags where integers expected, non-string identifiers, invalid schema versions.
- **Path & Directory Boundaries**: Missing nested directories (auto-creation), non-existent files, absolute vs relative paths.
- **Input Character Fidelity & Escaping**: Special characters, UTF-8 unicode strings, quotes, newlines, and CLI flag-like characters in objective and scope fields.
- **Budget Threshold Boundaries**: Zero attempts used, max attempts reached, budget limit check violations.
- **Filesystem Permissions**: Write-protected directories and read-only targets handled gracefully with non-zero exit codes.

### Tier 3: Combinations & Cross-Module Integration
Verifies interactions between distinct components:
- **State Machine ↔ Envelope Generation**: State machine `init` -> state updates -> `envelope.py create --from-state` -> state validation.
- **Provider Resolution Matrix**: Script vs Skill provider dispatching under varying stages (`workspace_prepare`, `issue_plan`, `issue_work`, `issue_verify`).
- **Multi-Step Pipeline Receipt Chaining**: Step 1 output receipt dynamically passed as predecessor receipt to Step 2 input envelope.
- **Budget Increment & Threshold Enforcement**: State machine transitions incrementing delivery and replan counters, correctly reflected in subsequent envelope generation.

### Tier 4: Real-World Scenarios
Simulates realistic end-to-end execution flows:
- **Scenario 1: End-to-End Orchestrator Dispatch Lifecycle**:
  Full workflow cycle: state initialization -> envelope generation -> envelope validation -> simulated subagent execution -> receipt emission -> state transition -> successor envelope creation.
- **Scenario 2: Autonomous Script Provider Execution**:
  Direct execution of a kernel script driven by an envelope file, verifying stdout JSON report and physical receipt file generation.
- **Scenario 3: Fault Injection & Recovery**:
  Handling corrupted envelope during dispatch, ensuring failure is trapped cleanly before state corruption occurs.

---

## 3. Directory Layout & Test Suite Map

```
tests/e2e/
├── test-helpers.ts                  # Shared execution wrappers, schema types, and temp fixtures
├── envelope-feature.test.ts         # Tier 1: Task Input Envelope & Provider Decoupling
├── kernel-receipt-feature.test.ts   # Tier 1: Kernel-Wrapper & Unified Receipt Contract
├── boundary-corner-cases.test.ts    # Tier 2: Boundary, schema violation & error tests
├── combinations.test.ts             # Tier 3: Cross-module integration (State Machine + Envelope)
└── real-world-scenarios.test.ts     # Tier 4: End-to-end dispatch & script execution scenarios
```

---

## 4. Test Execution & Quality Gates

The test harness is integrated directly into the project's standard toolchain:

| Command | Purpose | Target Budget |
|---|---|---|
| `npm test` | Runs all Vitest suites (including `tests/e2e/**/*.test.ts`) and Python tests | < 30s |
| `npm run typecheck` | Strict TypeScript compilation (`tsc --noEmit`) | < 10s |
| `npm run lint` | ESLint verification on scripts and tests | < 5s |
| `npx vitest run tests/e2e` | Runs E2E testing track suites exclusively | < 15s |
