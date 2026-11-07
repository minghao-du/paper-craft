---
name: pc-review-clean-code
description: Review code for clean-code violations — naming, single responsibility, fail-fast, type safety, DRY, test antipatterns. Trigger on "review code", "code review", "clean code review".
---

# /pc-review-clean-code

Conduct a thorough code review evaluating adherence to clean code principles. Read the diff, evaluate each hunk, and produce a structured review.

## Review Criteria

### Clean Code Principles

- **Single responsibility**: each function does one thing; each class owns one concern.
- **Naming excellence**: names reveal intent, match actual behavior, and distinguish observed vs. theoretical data. No comments needed to explain a well-named symbol.
- **Small functions**: short, focused, with clear descriptive names.
- **Import organization**: prefer top-level imports. Flag inline imports unless they guard a heavy optional dependency with documented justification.
- **Fail-fast philosophy**: prefer stopping execution with meaningful errors over silently handling bad data. Check for assertion usage, input validation, and early error detection.
- **Type safety over strings**: flag "stringly typed" code where enums, string unions, or constants would catch errors at type-check time (e.g., `phase: 'pre_cycle' | 'post_cycle'` instead of `phase: string`).
- **DRY**: identify duplicated logic and suggest proper abstractions.
- **Documentation quality**: complex systems need central documentation with examples and architectural explanations. Code should be self-documenting; strategic module-level docs for non-obvious systems.

### Test Quality Antipatterns

Flag these with high priority:

| Antipattern | Signal | Alternative |
|-------------|--------|-------------|
| **Mock abuse** | `vi.fn()`, `vi.mock()`, `vi.spyOn()` as default | Real data, fixtures, integration tests |
| **Trivial mocks** | `mockModel.predict.mockReturnValue([1,2,3])` | Load real model, test real behavior |
| **Fake test data** | `{"dummy": "values"}` literals | Real fixtures or factories |
| **Unjustified skips** | `test.skip()` / `it.skip()` without explanation | Fix or remove the test |
| **Missing integration tests** | Only mocked unit tests, no real component exercise | Add integration tests with real components |

## Methodology

1. **Initial scan**: overall structure, organization, immediate red flags.
2. **Deep analysis**: examine each function/method for single responsibility, complexity, and clarity.
3. **Pattern recognition**: identify recurring issues, architectural concerns, systemic problems.
4. **Constructive feedback**: specific, actionable recommendations with clear rationales.

## Output Format

### Strengths
Acknowledge well-written code and good practices (comprehensive testing, performance optimizations, clean abstractions).

### Critical Issues
Major problems impacting functionality or maintainability. Each with:
- Location (file:line)
- What's wrong and why it matters
- Concrete fix or code example

### Improvements
Specific suggestions for better adherence to clean code principles. Explain the *why* behind each recommendation.

### Refactoring Opportunities
Concrete before/after examples showing how to improve problematic code.

## Completion Criteria

- [ ] Every hunk in the diff evaluated against the review criteria above
- [ ] Test antipattern table checked against all test files in the diff
- [ ] Each finding includes location, rationale, and actionable fix
- [ ] Strengths section acknowledges good practices (not empty unless the code has none)
