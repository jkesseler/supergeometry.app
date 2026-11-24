---
paths:
  - "**/*.{ts,tsx}"
---

# TypeScript coding conventions

This app has no React, Payload or Mongo; sections and examples that name them
apply only if those are added.

## Purpose

Code is read far more often than it is written, and most of it is read by someone
who did not write it — including reviewers and LLMs. Optimise for the reader.

The guiding question for every decision below is: **how much does a reader have to
hold in their head to be sure what this does?** Fewer characters is not the goal.
Fewer things to work out is.

### How to read the rule levels

| Level | Meaning |
| --- | --- |
| **[Enforced]** | ESLint fails or warns on it. Not a matter of taste. |
| **[Convention]** | Dominant existing pattern. Follow it; deviating needs a reason. |
| **[Recommended]** | The preferred direction. Existing code is not wrong. |

Where sources conflict, resolve in this order: explicit project requirements →
enforced tooling → established codebase patterns → team conventions → general
best practice. Readability and maintainability outrank all of them; if a rule
below ever makes code harder to understand, the rule is wrong for that case.

---

## 1. Readability over brevity

When two versions do the same thing, prefer the one that needs less interpretation.

```ts
// GOOD — the control flow is a list you can read top to bottom:
// check, start if missing, return.
// Share an in-flight probe so concurrent health requests don't probe twice.
if (!state.inFlight) {
  state.inFlight = runAllProbes()
    .then((snapshot) => {
      state.cache = { snapshot, expiresAt: Date.now() + cacheTtlMs };

      return snapshot;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
}

return state.inFlight;
```

```ts
// BAD — same behaviour, but the reader must first recall that ??= assigns only
// when nullish, then infer the caching intent from the operator.
state.inFlight ??= runAllProbes().then(/* ... */);
```

**Do not prefer a language feature because it is newer or shorter.**
`??`, `??=`, `||=`, optional chaining, ternaries, destructuring, implicit returns,
chained calls and advanced generics are all allowed — when they make the intent
*more* obvious. When the compact form hides a decision the reader needs to see,
write the decision out.

Practical tests:

- If you have to mentally evaluate two expressions at once, split them.
- If a line reads left-to-right as a sentence, chaining is fine. If you have to
  scan back and forth, break it up.
- Do not add a temporary variable just to lengthen a line — and do not remove a
  well-named one just to shorten it. Name a value when the name explains something
  the expression doesn't.

**There is no enforced line-length limit.** That is not licence to write long
lines. Break wherever it aids scanning; a 200-character expression that lints
clean is still bad code.

**Never use numeric separators.** Write `10000`, not `10_000`. The `_` reads as a
digit at a glance and hides a wrong magnitude. This applies to every numeric
literal — timeouts, limits, byte sizes, everything. Not currently linted.

### Traps to avoid

Nested ternaries · nested destructuring · one-liners that pack a decision and an
action together · helper functions generic enough to serve two callers and clear
to neither · abstractions introduced before the second use case exists · functions
that mutate arguments or module state as a side effect of returning something ·
optimisation without a measurement.

---

## 2. Formatting  [Enforced]

`@stylistic` owns formatting — **there is no Prettier in this project.** Run
`npm run lint` rather than reaching for a formatter, and do not invent formatting
rules the config does not express.

- 2-space indent, single quotes, semicolons.
- **No trailing commas** (`comma-dangle: never`).
- Double quotes in JSX attributes; no braces around literal JSX props
  (`title="x"`, not `title={"x"}`).
- 1TBS braces, never on a single line. `if`/`else`/`for`/`while` always take
  braces, even for one statement.
- **Blank line before every `return`** that follows another statement. This one is
  an error, not a preference.
- Arrow parentheses `as-needed`, but **required when the body is a block**:
  `items.map(item => item.id)` and `items.forEach((item) => { … })`.
- Line breaks go *before* operators; multi-line ternaries break consistently.
- `;` separates members in `type` and `interface` bodies.
- Quote object keys only when the key requires it.
- `const` by default, `let` when reassigned, never `var`.
- Numeric separators: see §1 (not linted).

**Always use `===` and `!==`.**

**Also expected but unenforced** — template literals over string concatenation,
and no reassignment of function parameters.

**Escape hatches.** `eslint-disable` and `@ts-expect-error` are for real
constraints — a wrong third-party type, a known library bug. Each needs a comment
saying why. Keep them rare; their count is a feature.

---

## 3. Naming

Names carry most of the readability budget. Spend it here first.

Base naming rules — English, `camelCase`, boolean prefixes, verb prefixes,
singular/plural, no contractions, don't repeat context, match the name to the
result — are defined in [`.claude/rules/variable-naming.md`](./variable-naming.md).
Apply those first. Everything below is additive: TypeScript/React-specific
conventions that file does not cover.

| Kind | Convention | Example |
| --- | --- | --- |
| Components, types, collections | `PascalCase` | `ProductTile`, `Category` |
| Hooks | `use` + what it gives you | `useCurrentUser` |
| Props type | `<Component>Props` | `ProductTileProps` |
| Event handler props | `on<Event>` | `onAddToCart` |
| Local handlers | `handle<Event>` | `handleSubmit` |
| Fixed literal module constants | `SCREAMING_SNAKE_CASE` | `PAGE_SIZE` |
| Everything else at module scope | `camelCase` | `commerceClient`, `appConfig` |

`camelCase` is **[Enforced]** for identifiers you declare — object *properties*
are exempt, which is why OpenCascade and external API keys are legal.
The rest is **[Convention]**.

### Rules that matter

- **No `I` or `T` prefixes on types.** TypeScript does not need them and they
  carry no information. `ProductVariant`, not `IProductVariant`.
- **`SCREAMING_SNAKE_CASE` is narrow.** Use it only for fixed, literal,
  module-level values that act as configuration — tuning limits, cache keys,
  storage keys, regexes. A `const` holding a derived value, a client, or anything
  computed stays `camelCase`. Roughly a third of module constants qualify.
- **`handle*` vs `on*` is a real distinction**, not a synonym. `on*` is the prop
  the parent passes in; `handle*` is the local function that implements it.
- **`next`, `prev`, `min`, `max`** (base list in `variable-naming.md`): the
  replacement for something is `nextVariant`, not `newVariant` or `variant2`.
- **Single-letter names** warn below 2 characters, with `a`, `b`, `t`, `q`, `e`,
  `i`, `j`, `_`, and `x`, `y`, `z` for coordinates exempt (properties are exempt too). Even where allowed, prefer
  a real name: `error` beats `e`. Loop indices and `t` for the translate function
  are fine.
- **Unused values are prefixed `_`** — parameters, variables and destructured
  array slots. Caught errors may use `_` or `ignore`.
- **Verb prefixes**, beyond the base set in `variable-naming.md`: this codebase
  also uses `build` alongside `compose` (create from existing), and `find`
  (search, may return nothing).

### Files and folders

- **Utilities, services and functions: `camelCase.ts`** — `getCategories.ts`,
  `buildCatalogUrl.ts`, `commerceClient.ts`. Not kebab-case.
- **Components, collections and globals: `PascalCase`** — `Users.ts`,
  `ProductTile.tsx`. A component folder is named for the component and holds
  `index.tsx`.
- Role folders — `components`, `services`, `utilities`, `collections`, `jobs` —
  are lowercase.
- Tests are `tests/<name>.test.ts`, each a standalone script run with
  `npx tsx tests/<name>.test.ts`. There is no test runner.

---

## 4. Variables and destructuring

Destructure when it removes repetition. Do not destructure to save characters.

```ts
// GOOD — several values from one object, read once, named clearly.
const { baseUrl, timeoutMs } = appConfig.commerce;
```

```ts
// GOOD — one value from a deep path: direct access says exactly where it lives.
const pageSize = appConfig.env.catalog.pageSize;
```

```ts
// BAD — the reader has to unpick three levels of braces to learn one name,
// and the shape of appConfig is now scattered across the pattern.
const {
  env: {
    catalog: { pageSize }
  }
} = appConfig;
```

Rules of thumb:

- Multiple keys from the same object → destructure.
- One value, especially from a nested path → access it directly.
- Never nest destructuring more than one level.
- Do not reassign function parameters. Derive a new value instead.

---

## 5. TypeScript

The project runs in `strict` mode. Types exist to make wrong code fail early, not
to decorate it.

**Keep the visual weight of types as low as you can.** Annotations compete with
the logic for the reader's attention. The best type is the one you never had to
write because inference already got it right. When you do write one, it should be
because it tells the reader something the code does not.

- **Use `interface` for object shapes.** Reserve `type` for unions, aliases,
  mapped and conditional types — the things `interface` cannot express.
  Do not mix both styles for object shapes within one file.
- **Let inference do the work, including return types.** Do not annotate a return
  type that TypeScript already knows. Add one only when inference produces
  something wrong, unreadably wide, or when you deliberately want a narrower
  public contract than the body implies.
- **Annotate a local only when the inferred type is wrong or genuinely unclear.**
- **`export function` and `export const … = () =>` are both fine for module-level
  functions.** Be consistent within a file rather than converting either way.
- **Name non-trivial types instead of inlining them.** A one-field inline type in
  a signature is fine; a multi-field object literal in a parameter position is not.
- **Types live in the slice's `types.ts`.** Each vertical slice (feature folder)
  keeps its interfaces and type aliases in a colocated `types.ts`, and the slice's
  modules import from it. Do not scatter shape declarations through the
  implementation files. Exception: a type derived from a value
  (`ReturnType<typeof makeStore>`, `(typeof DISCIPLINES)[number]`) stays next to
  that value.
- **Pass an options object once a function takes more than two parameters**, and
  give it a named `interface`. `getProducts({ categoryPath, sector, page, take })`
  reads at the call site; four positional arguments do not.
- **Type-only imports go in their own `import type` statement**, grouped by
  source. Do not mix values and types in one specifier list:

  ```ts
  // GOOD — one statement per concern. The type import is visibly a type import.
  import { createDocument } from './document';
  import type { Document, DocumentDraft } from './types';

  // BAD — `type` buried mid-list. The reader has to parse each specifier
  // separately to know what is a value and what vanishes at build time.
  import { createDocument, type Document, type DocumentDraft } from './document';
  ```

  `isolatedModules` makes the value/type distinction load-bearing at build time,
  so keeping it visible in the statement itself is worth the extra line.
- **Nullable values:** prefer `undefined` for "not provided" and optional
  properties over `| null`, unless an external contract (OpenCascade, a file format, an API)
  gives you `null`. Handle absence explicitly at the top of a function rather than
  optional-chaining the same value repeatedly downstream.
- **Type assertions (`as`) are a claim the compiler cannot check.** Use one only
  at a boundary whose shape you have just verified, adjacent to the check that
  proves it. Never chain assertions to force an unrelated type.
- **Generics only when a real relationship exists** between an input and an output
  type — as in `findBySlug<Slug extends CollectionSlug>`, where the collection
  slug determines the document type. A generic with one call site is indirection.

### Untyped and unknown values

**Model the shape you actually use.** When data arrives from outside the type
system — an API response, a parsed document, a loosely typed library — write an
`interface` for the fields you read and move on. A small honest interface beats
both a wide `any` and a `unknown` you then have to unwrap.

- **Avoid `unknown`.** It does not describe anything; it defers the description
  and forces narrowing ceremony at every use site. The guard clauses it demands
  are noise unless the value's shape is genuinely in doubt at runtime.
- **`any` is acceptable where a type is genuinely not worth expressing** — a
  third-party shape you touch once, a deeply nested vendor payload. Keep it
  contained: name the fields you use rather than letting `any` spread through
  call chains and swallow real errors downstream.
- **`never` is for exhaustiveness checks** in discriminated unions — a genuinely
  useful pattern for `switch` over a union, and cheap to read.

**Caught errors are the one place narrowing pays for itself.** `strict` mode types
`catch` as `unknown`. Narrow once, at the catch:

```ts
} catch (error) {
  console.error('[rebuild] engine failed, keeping the last good model:', error);
  const message = error instanceof Error ? error.message : String(error);
}
```

That is the house idiom. Use it as-is rather than inventing a variation.

---

## 6. Functions and control flow

The target is code you can read once, top to bottom, without backtracking.

- **Guard clauses first.** Validate, bail out, then do the work. Prefer returning
  early over an `else` branch.
- **Keep nesting shallow.** Three levels is a practical ceiling. Deeper is usually
  a missing guard clause or a function that should be two functions.
- **A function should do one thing you can name.** If naming it needs "and", split
  it. There is no line limit, but a function that no longer fits on a screen is
  usually holding several ideas.
- **`async`/`await` over `.then()` chains** **[Convention]** — `await` reads as a
  sequence of steps. `.then()` still earns its place when you need the promise
  itself rather than its value: sharing an in-flight request, attaching cleanup
  with `.finally()`, storing a pending operation (see §1).
- **Use `Promise.allSettled` when independent operations should not cancel each
  other**, and handle each rejection explicitly — for example loading categories
  and products in parallel, where one failing should not blank the other.
- **Handle errors where you can act on them.** Wrap the narrowest operation that
  can fail. An empty `catch` is a bug. A `catch` that logs and continues must make
  the fallback obvious — log *what* it fell back to, not just that it failed.
- **Do not catch merely to rethrow unchanged.**
- **No hidden side effects.** A function named `get*` must not mutate. If it does
  both, name it for the mutation or split it.

```ts
// GOOD — every precondition is visible before any work happens.
const categories = await getCategories(sector);

if (!categories.length) {
  return [];
}
```

### Conditionals

- Ternaries are good for choosing between two simple values.
- **Never nest ternaries.** Use `if`/`return`, or extract a small named function.
- Avoid `condition ? true : false`.
- Prefer `if` over `&&`/`||` used purely for side effects. `cond && doThing()`
  passes lint (short-circuits are exempted) but states a boolean expression while
  meaning "call it if present". Write what you mean.
- Extract a compound condition into a named boolean when it encodes a rule:
  `const shouldShowFacets = facets.length > 0 && products.length > 1;`

---

## 7. React

- **Function components, named exports, arrow style** **[Convention]**:
  `export const ProductTile = () => { … }`. Module-level helpers in the same file are
  plain `function` declarations.
- **Do not use `React.FC`.** It adds nothing over typing the props parameter and
  obscures the actual signature.
- **Destructure props in the signature** and use them consistently.

```tsx
// GOOD — the component's inputs are visible in one line.
export const ProductTile = ({ product, facetsDictionary, onAddToCart }: ProductTileProps) => {
```

```tsx
// BAD — three access styles for one object. A reader cannot tell whether
// `props?.` guards a real case or is defensive noise.
export const ProductTile = (props: ProductTileProps) => {
  const { product } = props;
  const variant = findMatchingVariant(product, props?.facetsDictionary);
  if (!props.onAddToCart) { /* ... */ }
```

- **Props type lives in the slice's `types.ts`**, named `<Component>Props`.
- **Component body order:** hooks → derived values → effects → handlers → early
  returns → JSX. Consistent ordering means a reader always knows where to look.
- **Derive during render; do not mirror props into state.** Compute plain values
  inline. Reach for `useMemo`/`useCallback` only for a measured cost or a
  genuinely required stable identity.
- **Effects synchronise with something outside React** (subscriptions, timers,
  the DOM, fetches). An effect that only computes a value from props should be a
  derived value instead.
- **Never suppress a dependency warning to make an effect behave.** The usual
  temptation is an effect that writes state it also depends on, with the
  dependency omitted to stop the loop. That works by accident and breaks under
  edits. Fix the data flow — derive rather than store, move the logic into the
  event handler that caused the change, or use a ref for a value you deliberately
  do not want to react to.
- **Conditional rendering:** early-return for whole-component states (loading,
  empty, error). Inside JSX use `{condition && <X />}` or a single ternary — if
  you need more branches, extract a component or compute the element above the
  return.
- **`'use client'` is the first line of the file**, above all imports. Add it only
  to components that genuinely need browser APIs, state or effects; everything
  else stays a server component.
- Extract pure display logic (formatting, text selection) into module-level
  functions above the component. It keeps the component body about behaviour and
  makes the logic testable without rendering.

---

## 8. Imports

Order **[Enforced]** as an error, by path group:

1. Node builtins
2. External packages
3. `@/**` aliases (none configured yet)
4. Other internal
5. Parent (`../`)
6. Sibling (`./`)
7. Index

**No blank lines between import groups** — the config sets
`newlines-between: 'never'`. This differs from most projects; do not add
separating blank lines.

**[Recommended]** Put type-only imports at the end of the block. The config lists
a trailing `type` group, but it does not fire on interleaved `import type`
statements — several files interleave them and lint clean. Grouping them last is
a readability convention here, not something the linter will catch.

Imported names must actually exist in the target module (`import/named`).

There are no path aliases; imports are relative.

---

## 9. Comments
- Default to no comment. Code shows *how*; comment only to carry *why* — a non-obvious constraint, deliberate deviation, gotcha, or workaround.
- Never narrate the code ("loop over users", "parse the body"), restate names/types/signatures, or mark block ends.
- Never narrate the change ("fixed X", "updated to Y", "as requested"). A comment must read correctly to someone seeing the file fresh who never saw the diff; change context belongs in the commit message.
- Delete by default. A comment that just restates a decision the code already reflects — "1 vCPU is deliberate", "right-sized from prod" — is dead weight even when it points to a doc: the doc is where anyone questioning it looks anyway. Keep inline only what a reader needs *at that line* and can't get from the code — a non-obvious invariant/constraint ("timeout must stay < interval — ALB rule") or a cross-file sync obligation ("keep in sync with the router's TGs").
- Comments must stand on their own with any link removed — encode the substance, never a pointer as a substitute for it. Banned: specs, section numbers, design docs — point-in-time artifacts that get superseded and rot ("spec §7" is the canonical case). Fine: a maintained doc/README at a stable path — and when the *why* is a system-level narrative ("why it's built this way"), extract it there as a *pure* extraction: not an inline block, and not a comment that merely points to the doc. What stays inline are the non-obvious local details, which reference the doc only when a reader genuinely needs it *at that line* — a pointer-only comment generally shouldn't exist at all. Tickets, Confluence, RFCs, permalinks stay fine as trailing breadcrumbs.
- Occam's razor on every comment you *keep*, not just the ones you delete. "Carries a real *why*" and "is worded minimally" are independent judgments — a genuine *why* can still be 3x too long, and "it's a real why" is not license to keep the wording verbatim. Keep only the one non-obvious fact a reader needs *at that line*, in the fewest words; cut the mechanism the code already shows, where a value is consumed downstream, the consequence-of-the-consequence, and justification-of-the-justification. A 5-line block almost never survives intact — suspect it on sight; the razored answer is sometimes zero.
- A one-line summary on a public function/endpoint is fine; inline restatement of a single clear line never is.
- TODOs are fine and don't need issue IDs — but a TODO is a marker, not a substitute for doing the work in scope.

Write code that does not need explaining — good names, small functions, explicit
control flow. Then comment what the code cannot say. Most lines need no comment;
the ones that do usually encode a decision someone would otherwise undo.

**Comment when it explains a decision or a constraint:**

- business rules, and why a threshold or special case exists
- non-obvious external-system behaviour
- workarounds, with a link or ticket
- why a surprising implementation was chosen over the obvious one
- why an `eslint-disable` or `@ts-expect-error` is justified

**Do not narrate the code:**

```ts
// GOOD — states the constraint. Without it, someone raises the value and
// probes start overlapping.
// Must stay below the compose healthcheck interval.
const PROBE_TIMEOUT_MS = 2000;

// BAD — the line below already says this.
// Set the probe timeout to 2000 ms.
const PROBE_TIMEOUT_MS = 2000;
```

JSDoc is worth writing for exported functions whose contract is not obvious from
the signature — ownership, error behaviour, side effects, units. It is not
required on every export, and a block that restates the parameter names is worse
than none. The bar to clear:

```ts
/**
 * Run a health probe and convert every failure into a ProbeResult.
 *
 * Probes report; they never throw. A health check that throws is least useful
 * precisely when the dependency is unhealthy.
 */
```

That second paragraph is the whole value — it tells you why the signature has no
error channel, which the types cannot.

Mark unfinished work as `// TODO:` with enough context to act on it.

---

## 10. Errors and logging

- **Use `console.error` / `console.warn`** **[Convention]** — this is a browser
  app with no server logger. `console.log` should not reach the main branch.
- **Pass the error itself as the last argument**, not interpolated into the
  message: the console keeps its stack. Prefix the message with the originating
  function in brackets so a log line is greppable (see §5).
- Never log secrets, tokens, credentials or personal data. Do not log upstream
  response bodies or error messages verbatim where they could contain arbitrary
  content — categorise the failure instead.
- Fail loudly in development, degrade gracefully in production: a caught error
  that leaves the app usable should still be reported.

---

## 11. For LLMs generating or modifying code

Most of this codebase is generated. That makes these rules load-bearing rather
than advisory — nobody is hand-correcting the drift afterwards.

- **Match nearby code** when it does not conflict with these conventions.
  Consistency within a file beats global consistency. Where this document
  conflicts with surrounding code, follow it for new code and leave the rest alone.
- **Change only what was asked.** No unrelated refactoring, no renaming, no
  reformatting untouched lines, no "while I was here" improvements. Preserve
  existing behaviour — including edge cases that look like bugs. Report them
  instead of fixing them silently.
- **Make the smallest change that completely solves the problem.**
- **Do not modernise working code.** A `.then()` chain or a `function` declaration
  that works is not a defect.
- **Prefer readability over brevity** every time. Do not compress readable
  multi-line code into one-liners, and do not reach for an advanced language
  feature without a readability gain you could defend in review.
- **Do not abstract speculatively.** Write the second use case before extracting
  the shared helper.
- **Do not add defensive layers nobody asked for** — redundant null checks,
  try/catch around code that cannot throw, validation the type system already
  guarantees. Generated code drifts toward this; resist it.
- **Use descriptive names** and make control flow explicit.
- **Follow ESLint.** Do not invent formatting rules, and do not add
  `eslint-disable` or `@ts-expect-error` to make an error go away.
- **Keep types quiet.** Do not add return-type annotations inference already
  provides, do not reach for `unknown`, and do not generate narrowing guards for
  values whose shape you already know. Write an `interface` and move on.
- **Verify before reporting done.** Run `npm run typecheck`, `npm run lint` and
  the relevant `npx tsx tests/<name>.test.ts`. Say what you actually ran. Type-checking alone is not evidence that
  a change works.
