interface Point {
  x: number;
  y: number;
}
interface Line {
  start: Point;
  end: Point;
}
const a: Point = { x: 0, y: 0 };
const b: Point = { x: 3, y: 4 };
const l: Line = { start: a, end: b };
console.log(l.end.x);
