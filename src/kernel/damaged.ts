/** The furthest from the origin a body may reach (mm): past it OpenCascade's own tolerances stop meaning anything. */
export const MAX_REACH = 1e7;

/** A step's vectors, where the file should hold [x, y, z] (or [x, y]). */
const VECTOR_KEYS = new Set(['origin', 'xDir', 'normal', 'dir', 'mid', 'center', 'translate', 'factors']);
/** A step's lists (the bodies it works on, its tools, edges, faces...): a list where the file has one at all. */
const LIST_KEYS = new Set(['tools', 'bodies', 'edges', 'faces', 'regions', 'sections', 'entities']);
/**
 * Is a step's saved data broken (a damaged file, or one written by something
 * else): a vector that isn't numbers, a number that is missing from a list of them?
 */
export function damaged(value: unknown, key = '', depth = 0): boolean {
  if (value === null || typeof value !== 'object') {
    return (VECTOR_KEYS.has(key) || LIST_KEYS.has(key)) && value !== undefined;
  }
  if (Array.isArray(value)) {
    const numbers = value.some(item => typeof item === 'number');
    if (numbers && !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
      return true;
    }
    if (VECTOR_KEYS.has(key) && (!numbers || value.length < 2 || value.length > 3)) {
      return true;
    }
    if (numbers) {
      return false;
    }

    return value.some(item => damaged(item, '', depth + 1));
  }
  if (VECTOR_KEYS.has(key) || LIST_KEYS.has(key)) {
    return true;
  }
  for (const [key, x] of Object.entries(value)) {
    // (An imported file's bytes, a sketch's history: not values of the step.)
    if (depth === 0 && (key === 'data' || key === 'log')) {
      continue;
    }
    if (damaged(x, key, depth + 1)) {
      return true;
    }
  }

  return false;
}
export const DAMAGED_TEXT = "This step's saved values are damaged or incomplete - open it and set them again, or delete it";
