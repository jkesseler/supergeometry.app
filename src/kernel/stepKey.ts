/**
 * A step's big values (an imported model's megabytes) as a short fingerprint
 * in the text its key is made from, worked out once per value: hashing them
 * character by character on every rebuild cost 15 ms per 5 MB, every step of
 * a drag.
 */
const bigPrints = new Map<string, string>();
export function shortBig(_k: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length < 20_000) {
    return value;
  }
  let print = bigPrints.get(value);
  if (!print) {
    print = `\u0000big:${hash53(value, 11)}.${hash53(value, 13)}.${value.length}`;
    if (bigPrints.size > 64) {
      bigPrints.clear();
    }
    bigPrints.set(value, print);
  }

  return print;
}

/** Key of the steps so far: the previous key and this step's JSON, hashed (two 53-bit hashes, no collisions in practice). */
export function chainKey(prev: string, json: string): string {
  return `${hash53(prev + json, 1)}.${hash53(json, 7)}.${json.length}`;
}

/** cyrb53: a fast, well-mixed 53-bit string hash. */
export function hash53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
