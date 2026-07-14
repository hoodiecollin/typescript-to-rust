# 079 — Closure-captured containers: specs

Differential-oracle specs (compile → `cargo run` → compare stdout vs Bun-run TS)
for issue **#46**. Graduates closure capture of a container in the **stored-arrow**
(`const f = () => {…}`) and **inline-callback** (`.map`/`.filter`/…) lowering paths.
Rows shipped: **read-only** capture (`&T`) and **owned-mutable, non-aliased** capture
(`&mut T`). The **shared/aliased** container needing `Rc<RefCell<T>>` and every
**escaping** closure stay **fail-loud** (documented residuals).

## Shipped rows

- **CC1 — read-only stored capture.** `const arr = [1,2,3]; const sum3 = () =>
  arr[0]+arr[1]+arr[2]; console.log(sum3());` → the lifted fn takes `arr` by `&`;
  differential `6`.
- **CC2 — owned-mutable stored capture (Set).** `const s = new Set<number>(); const
  add = (x:number) => { s.add(x); }; add(1); add(2); add(2); console.log(s.size);`
  → the lifted fn takes `s` by `&mut`, threaded per call; differential `2`.
- **CC3 — owned-mutable stored capture (array push).** `const acc:number[] = []; const
  push2 = (x:number) => { acc.push(x*2); }; push2(1); push2(2); console.log(acc[0], acc[1]);`
  → `&mut acc`; differential `2 4`.
- **CC4 — owned-mutable stored capture (Map).** `const m = new Map<string,number>();
  const put = (k:string, v:number) => { m.set(k, v); }; put("a", 1); put("b", 2);
  console.log(m.get("a") ?? -1);` → `&mut m`; differential `1`.
- **CC5 — multiple captured containers.** one stored closure mutating two owned
  containers → two threaded params (stable order); differential-matches.
- **CC6 — read-only inline capture.** `const base = [10,20]; const ys = [1,2].map(x =>
  x + base[0]); console.log(ys[0], ys[1]);` → the inline lifted fn takes `base` by
  `&`; differential `11 12`.
- **CC7 — owned-mutable inline capture.** `const acc:number[] = []; [1,2,3].map(x => {
  acc.push(x*2); return x; }); console.log(acc.length);` → forwarded `&mut acc`;
  differential-matches. *(Kept to a single-container `.map` body.)*
- **CC8 — a captured container read AND mutated in one stored closure.** one `&mut`
  param, reads through it; differential-matches.

## Fail-loud residuals

- **CC9 — escaping stored closure (returned).** a captured-container closure that is
  **returned** from a fn → `UnsupportedError` (env-threading can't represent it).
- **CC10 — escaping stored closure (stored in an array).** `arr.push(add)` on a
  capturing closure → `UnsupportedError`.
- **CC11 — shared/aliased captured container.** the captured container's owner is
  aliased (`const t = s;`) → fail-loud (the `Rc<RefCell>` row, deferred).
- **CC12 — scalar mutable capture (stored).** `let n = 0; const inc = () => { n++; };`
  → `UnsupportedError` (unchanged 048 residual; the container graduation does not
  touch a captured scalar).
- **CC13 — captured container reassigned wholesale.** `const s = new Set<number>();
  const reset = () => { s = new Set<number>(); };` — a rebind of the binding, not a
  method mutation → fail-loud.

## Regressions (unchanged)

- **CC14 — Copy-scalar inline capture unchanged.** `const k=2; const ys=[1,2,3].map(x
  => x*k); console.log(ys[0]);` — the 048 read-only scalar-forward path, byte-for-byte
  unchanged.
- **CC15 — non-capturing stored arrow unchanged.** `const inc = (n:number):number =>
  n+1; console.log(inc(4));` — still a direct free `fn`.
- **CC16 — `.forEach` container mutation unchanged.** `const acc:number[]=[];
  [1,2,3].forEach(x => acc.push(x)); console.log(acc.length);` — still the for-loop
  lowering (not a lift), differential-matches.
</content>
</invoke>
