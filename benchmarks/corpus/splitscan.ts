/**
 * Split + scan where each piece is genuinely **read** (not discarded). Complements
 * `strbuild` (whose split-loop binder is unused): here the for-of reads every piece
 * via a read-only predicate, so it exercises series 107's lazy `split` on a *used*
 * borrowed `&str` element — proving the streaming win isn't tied to the discard shape.
 * Kept ASCII so results agree across runtimes.
 */
export function run(): number {
  // Build a delimited string: pieces "ab", "cd", "efg" separated by "5".
  let s: string = "";
  for (let i: number = 0; i < 4000; i = i + 1) {
    s = s + "ab5cd5efg5";
  }
  // Scan repeatedly: split on "5", count pieces equal to "ab". The piece `p` is read
  // (a borrow-only equality), so the split streams a borrowed `&str` instead of
  // allocating a Vec<String> of thousands of pieces each round.
  let hits: number = 0;
  for (let r: number = 0; r < 300; r = r + 1) {
    for (const p of s.split("5")) {
      if (p === "ab") {
        hits = hits + 1;
      }
    }
  }
  return hits;
}
