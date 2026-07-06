class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
  scale(k: number): void {
    this.w = this.w * k;
    this.h = this.h * k;
  }
}
const r: Rect = new Rect(2, 3);
r.scale(2);
console.log(r.area());
