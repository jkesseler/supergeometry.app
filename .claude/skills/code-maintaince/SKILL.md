# Codebase Maintenance Skill

## Purpose

Maintain this codebase with the smallest reasonable change while producing readable, understandable, maintainable, production-quality code.

Optimize for:

1. Readability
2. Understandability
3. Low cognitive load
4. Consistency
5. Maintainability
6. Minimal change

Prefer explicit and predictable code over clever, compressed, or overly abstract code.


## Before Changing Code

Before modifying code:

1. Read `CLAUDE.md`.
2. Read `.claude/rules/coding-conventions.md`.
3. Read `.claude/rules/variable-naming.md` when relevant.
4. Read other relevant rules in `.claude/rules/`.
5. Inspect the target file.
6. Inspect related code when the change crosses module or architectural boundaries.
7. Inspect nearby code for established patterns only if the conventions do not apply.

Do not guess about project conventions or architecture when the codebase can answer the question.

Prefer established project patterns over introducing new ones.


## Code Style

`.claude/rules/coding-conventions.md` is the source of truth for coding conventions.

Follow it when:

- writing new code,
- modifying existing code,
- refactoring,
- naming variables or functions,
- choosing TypeScript patterns,
- structuring React components.

When a code-style decision is ambiguous, prefer the option with lower cognitive load.

Do not choose a shorter or more "idiomatic" implementation merely because it uses fewer lines.

For example, prefer explicit control flow when it is easier to understand than a compact operator or expression.

Do not introduce advanced language features merely to make code shorter.


## Existing Code

Match nearby code when it is consistent with the project conventions.

Do not blindly copy existing code if it:

- clearly violates the coding conventions,
- increases unnecessary complexity,
- appears to be legacy code,
- is inconsistent with surrounding code.

When modifying existing code, avoid unnecessary stylistic changes.

Do not reformat or refactor unrelated code.


## Comments

Default: do not add comments.

Prefer clear names and structure over explanatory comments.

Add comments only when they explain something that cannot reasonably be understood from the code itself, such as:

- business rules,
- non-obvious constraints,
- workarounds,
- external-system behavior,
- surprising behavior,
- important implementation decisions.

Comments should explain **why**, not **what**.

Avoid comments that merely describe obvious code.

Avoid JSDoc unless it provides meaningful value, particularly for public APIs.


## TypeScript

Follow `.claude/rules/coding-conventions.md` for TypeScript conventions.

In general:

- Prefer type inference when the type is obvious.
- Prefer explicit types when they communicate important intent or prevent ambiguity.
- Prefer type-safe solutions over `any`.
- Use `unknown` when the type is genuinely unknown.
- Avoid unnecessary type assertions.
- Avoid unnecessarily complex type definitions.
- Keep types close to where they are used unless they are genuinely shared.
- Do not create a `types.ts` file solely to move a small or local type elsewhere.

Use interfaces and type aliases according to the project conventions rather than applying an unconditional rule to prefer one over the other.


## React

Follow existing React patterns and `.claude/rules/coding-conventions.md`.

In general:

- Match nearby component structure.
- Do not introduce `React.FC` unless required by existing project patterns.
- Keep component logic easy to scan.
- Prefer early returns over deeply nested JSX.
- Avoid unnecessary effects.
- Avoid unnecessary abstractions.
- Keep component-specific types close to the component unless they are shared.


## Changes

Make the smallest change that completely solves the problem.

Before changing code, understand the requested behavior.

After changing code:

- Preserve existing behavior unless the change intentionally modifies it.
- Avoid unrelated refactoring.
- Avoid opportunistic cleanup.
- Avoid renaming unrelated code.
- Avoid introducing abstractions without a clear benefit.
- Remove complexity when doing so is directly related to the change.
- Do not rewrite working code merely to make it more idiomatic.

A small, clear change is preferable to a broad "improvement".


## Error Handling

Preserve existing error-handling conventions.

When adding error handling:

- Do not swallow errors without a reason.
- Do not expose sensitive information.
- Prefer actionable error messages.
- Handle expected failure modes explicitly.
- Avoid catching errors merely to rethrow them unchanged.

Inspect nearby code before introducing a new error-handling pattern.


## Testing

After making changes, run the most relevant available checks.

Prefer focused verification over running unrelated tooling.

When applicable, run:

    npm run typecheck

Run linting according to the project's configured tooling.

Do not use auto-fix as a substitute for reviewing the resulting changes.

If a command modifies files, inspect the changes before considering the task complete.

Add or update tests when behavior changes.

Prefer focused unit tests with mocked dependencies where appropriate.

Do not add integration or end-to-end tests unless they are appropriate for the change or explicitly requested.


## Verification

Before reporting completion:

1. Review the final diff.
2. Confirm that the requested behavior is implemented.
3. Confirm that unrelated files were not changed unnecessarily.
4. Run relevant type checks, linting, and tests.
5. Inspect the output of commands that modify files.
6. Mention what was actually verified.

Never claim that a change works solely because it type-checks.

If something could not be verified, say so explicitly.


## LLM Behavior

When generating or modifying code:

- Prefer readability over brevity.
- Prefer explicit control flow when it reduces cognitive load.
- Do not use clever syntax merely because it is shorter.
- Do not introduce unnecessary abstractions.
- Do not introduce new patterns without first checking existing code.
- Do not refactor unrelated code.
- Do not silently change behavior.
- Do not make speculative improvements.
- Do not over-engineer the solution.
- Preserve useful existing structure.
- Follow project rules before general language preferences.

When multiple valid implementations exist, choose the simplest implementation that is easy for another developer to understand.


## Communication

Keep responses concise.

When reporting completed work, explain:

- what changed,
- why it changed,
- what was tested.

Mention relevant limitations or verification failures.

Do not provide lengthy explanations unless requested.