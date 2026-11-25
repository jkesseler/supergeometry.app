/**
 * The engine itself broke down on a step (out of memory, a fault inside
 * OpenCascade): nothing it holds can be trusted after that. Whoever runs the
 * engine loads a fresh one, calls `resetKernel`, and asks again - the step
 * that did it is remembered (by its key) and refused with words from then on.
 */
export class KernelFault extends Error {
  constructor(readonly featureId: string) {
    super('The geometry engine broke down and has to be restarted');
  }
}
const FAULT_TEXT = 'This step made the geometry engine run out of memory or break down (a value far too big, or too small?) - change its values, or delete it';
/** Steps (by key) that broke the engine: not tried again. */
export const crashed = new Map<string, string>();
/**
 * Steps the engine broke down on once. The first time may be the engine's
 * memory having filled up over a long session (it never gives any back), so
 * the step gets a second go on the fresh engine; only if that breaks too is it the step.
 */
const suspects = new Set<string>();
export function blame(key: string): void {
  if (crashed.size > 200) {
    crashed.clear();
  }
  if (suspects.size > 200) {
    suspects.clear();
  }
  if (suspects.has(key)) {
    crashed.set(key, FAULT_TEXT);
  } else {
    suspects.add(key);
  }
}

/** Is this the engine breaking down (not a step that merely can't be done)? */
export function isFault(err: unknown): boolean {
  if (err instanceof KernelFault) {
    return true;
  }
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) {
    return true;
  }
  const text = err instanceof Error ? `${err.name} ${err.message}` : typeof err === 'string' ? err : '';

  return /memory access out of bounds|out of memory|unreachable|table index is out of bounds|null function or function signature mismatch|Aborted\(|Maximum call stack|Expected null or instance of|Cannot pass deleted object|BindingError/i.test(text);
}
