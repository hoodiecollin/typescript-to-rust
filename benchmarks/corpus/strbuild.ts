/**
 * String building + scanning — concatenation into a growing buffer, then repeated
 * split/search rounds over the built string. Stresses the string representation,
 * substring search, and the allocation churn of `split`. The split result is
 * folded via a for-of counter (so it is genuinely consumed, not dead-code
 * eliminated). Kept ASCII so results agree across runtimes.
 */
export function run(): number {
  let s: string = "";
  for (let i: number = 0; i < 20000; i = i + 1) {
    s = s + "abc" + (i % 10);
  }
  let checksum: number = 0;
  for (let r: number = 0; r < 300; r = r + 1) {
    const parts: string[] = s.split("5");
    for (const _p of parts) {
      checksum = checksum + 1;
    }
    checksum = checksum + s.indexOf("789");
  }
  return checksum;
}
