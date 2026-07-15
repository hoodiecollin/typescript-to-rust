/**
 * Specs for series 032 — nested / inferred struct literals (gap B from 030).
 *
 * A struct object literal was only recognized at the top level of a struct-typed
 * binding; an *inline nested* literal (`{ start: { x: 0, y: 0 } }`) or a struct
 * literal *inside a collection* (`Array<Point>` = `[{ x: 1, y: 2 }]`) fell through
 * to the bare-object-literal `UnsupportedError`. This series recurses into a
 * field's / element's declared struct type.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("struct-literals", [
  {
    name: "an inline nested struct literal lowers recursively",
    src: `interface Point { x: number; y: number; }
interface Line { start: Point; end: Point; }
const l: Line = { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } };
console.log(l.end.x);`,
    expected: "3",
  },
  {
    name: "a two-level nested struct literal lowers recursively",
    src: `interface Point { x: number; y: number; }
interface Seg { a: Point; b: Point; }
interface Path { head: Seg; }
const p: Path = { head: { a: { x: 1, y: 2 }, b: { x: 5, y: 6 } } };
console.log(p.head.b.x);`,
    expected: "5",
  },
  {
    name: "a struct literal inside an Array element lowers",
    src: `interface Point { x: number; y: number; }
const pts: Array<Point> = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
console.log(pts[1].y);`,
    expected: "4",
  },
]);
