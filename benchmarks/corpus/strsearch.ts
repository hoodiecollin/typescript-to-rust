/**
 * Substring search in isolation (#92). Builds one large haystack, then scans it
 * many times with `indexOf`. The `from` offset is derived from the loop counter so
 * neither a warmed JIT nor rustc can hoist the (otherwise loop-invariant) search out
 * of the loop — this measures real substring-search throughput, not invariant
 * hoisting. Covers both the miss case (`"789"`, never present → full scan to the end)
 * and a hit. This is the cost that kept `strbuild` a loss before #92 routed
 * `tslib::string::index_of` through `str::find` (memchr) instead of collecting the
 * whole haystack into a `Vec<char>` per call. Kept ASCII so results agree across runtimes.
 */
export function run(): number {
  let s: string = "";
  for (let i: number = 0; i < 20000; i = i + 1) {
    s = s + "abc" + (i % 10);
  }
  let checksum: number = 0;
  for (let r: number = 0; r < 2000; r = r + 1) {
    checksum = checksum + s.indexOf("789", r); // miss: scans from r to end → -1
    checksum = checksum + s.indexOf("abc2", r % 50); // hit: from varies, defeats hoist
  }
  return checksum;
}
