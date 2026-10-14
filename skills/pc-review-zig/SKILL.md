---
name: pc-review-zig
description: Review Zig code for memory safety, explicit resource ownership, comptime vs type-erased interfaces, and data-oriented design.
disable-model-invocation: true
---

# /pc-review-zig

Review Zig code for memory safety, explicit resource allocation, comptime correctness, and data-oriented performance patterns.

## Review Focus Areas

### 1. Comptime vs. Type-Erased Interfaces
- **Comptime duck typing** (`fn write(writer: anytype)`): Zero-cost monomorphization. Required for inner loops and hot paths when concrete types are known at compile time. Ensure required methods are verified via `comptime` checks or `@compileError`.
- **Type-erased interfaces** (`std.io.AnyWriter`, `std.mem.Allocator`): Fat pointer + vtable. Required when types must be stored in struct fields, dynamic arrays, or passed across runtime callbacks.
- **Flags**: Flag type-erased interfaces on hot paths where `anytype` is feasible; flag `anytype` parameters on structs attempting to store the value as a field.

### 2. Tagged Unions vs. Parallel State
- Flag parallel arrays of enum tags and payloads; use tagged unions (`union(enum)`).
- Flag `else =>` branches in switches over tagged unions or non-exhaustive enums. All branches should be handled explicitly to retain compiler exhaustiveness checks when variants are added.

### 3. Resource Ownership & Allocator Discipline
- Every struct with a `deinit` must clearly document owned vs. borrowed fields (especially string slices `[]const u8`).
- Allocator symmetry: If `init` takes an `Allocator`, `deinit` must take the same `Allocator` or clean up using the stored allocator.
- Slices returned from functions: Functions that allocate must require an `Allocator` parameter (convention: caller owns memory).
- Leaks and error unwinding: Check that all allocation sites have matching `defer allocator.free(...)` or `errdefer allocator.free(...)` before any fallible operations.

### 4. Memory Safety & Pointers
- Lifetime checks: Detect dangling slices from stack buffers, use-after-free around arena resets, or slicing into reallocated `std.ArrayList` buffers.
- Flag bare `.?` or `catch unreachable` unless preceded by an explicit invariant assertion.

### 5. Data-Oriented Design & Performance
- **Array of Structs (AoS) vs. Struct of Arrays (SoA)**: In hot loops iterating over large arrays, evaluate `std.MultiArrayList` to optimize cache line utilization.
- Cache friendliness: Avoid pointer-chasing and unnecessary indirection (pointers to pointers, nested slices) in inner loops.
- Struct alignment & padding: Place larger fields first or check `@alignOf` when arranging high-frequency structs.

### 6. Error Handling
- Prohibit swallowed errors: Flag `catch {}` or `catch |_| {}` without explicit justification and logging.
- Avoid returning `anyerror` where a specific error set can be declared.

## Report Structure

Format findings into:
1. **Safety & Correctness**: Leaks, lifetime bugs, unhandled errors, missing `errdefer`.
2. **Architecture & Idioms**: Comptime vs runtime dispatch, tagged union patterns, allocator ownership.
3. **Performance & Layout**: Cache locality, redundant copies, AoS/SoA opportunities.
4. **Actionable Recommendations**: Concrete Zig code corrections with line references.
