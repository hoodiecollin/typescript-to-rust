/**
 * Sort a pseudo-random array (deterministic LCG so all three runtimes see the
 * same input) with a comparator, then fold the sorted array to a checksum via a
 * for-of walk. Exercises the runtime's sort + comparator-callback path. The
 * per-element values stay well within f64's exact-integer range and are summed in
 * the same order everywhere, so the checksum agrees byte-for-byte.
 */
export function run(): number {
  const n: number = 200000;
  const xs: number[] = [];
  let seed: number = 123456789;
  for (let i: number = 0; i < n; i = i + 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    xs.push(seed);
  }
  xs.sort((a: number, b: number): number => a - b);
  let checksum: number = 0;
  let idx: number = 0;
  for (const v of xs) {
    if (idx % 1000 === 0) {
      checksum = checksum + v;
    }
    idx = idx + 1;
  }
  return checksum;
}
