# 101 — RegExp specs (`RE` prefix)

Spec-first BDD, oracle-driven. Each **differential** case is a complete `.ts`
program whose Rust emission must `cargo run` and byte-match Bun running the same
TS. Each **fail-loud** case must throw the named error (`UnsupportedError` /
`DialectError`) at transpile time with a message naming the construct.

Char-index note: offsets follow the 083/098 char-indexed model; ASCII inputs are
used throughout so no `char`-vs-UTF-16 divergence is exercised (the divergence is
documented in design.md, not spec'd here).

---

## Differential specs (emit → `cargo run` stdout == Bun stdout)

### RE-1 — `re.test`, `/\d+/`
```ts
const re = /\d+/;
console.log(re.test("abc123"));   // true
console.log(re.test("abcdef"));   // false
```
Rust: `tslib::regex::Regex::new_lit("\\d+", false).is_match(...)` → `bool`.

### RE-2 — case-insensitive flag `i` → `(?i)`
```ts
console.log(/hello/i.test("HELLO WORLD"));  // true
```

### RE-3 — multiline `m` and dotAll `s` flags
```ts
console.log(/^bar$/m.test("foo\nbar\nbaz"));  // true
console.log(/a.b/s.test("a\nb"));             // true
```

### RE-4 — `s.match` with numbered groups
```ts
const m = "ab".match(/(\w)(\w)/);
console.log(m !== null);   // true
console.log(m![0]);        // "ab"  (whole match)
console.log(m![1]);        // "a"
console.log(m![2]);        // "b"
```
`re.captures` → `[full, g1, g2]`; `None` group → `undefined` (066 Option model).

### RE-5 — `s.match` with the `g` flag (full matches, no groups)
```ts
const all = "a1b2c3".match(/\d/g);
console.log(all!.length);  // 3
console.log(all!.join(",")); // "1,2,3"
```
`re.find_all` → `Vec<String>`.

### RE-6 — `s.replace(re, str)` first-only and global
```ts
console.log("banana".replace(/a/, "o"));    // "bonana"  (first only)
console.log("banana".replace(/a/g, "o"));   // "bonono"  (all, g flag)
console.log("banana".replaceAll(/a/g, "o")); // "bonono"
```

### RE-7 — numbered replacement template `$1`
```ts
console.log("John Smith".replace(/(\w+)\s(\w+)/, "$2 $1"));  // "Smith John"
```
Template `$1`/`$2` → `regex` `${1}`/`${2}`.

### RE-8 — named-group capture + `$<name>` replacement
```ts
const s = "2026-07-16";
const m = s.match(/(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})/);
console.log(m!.groups!.y);   // "2026"
console.log(s.replace(/(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})/, "$<d>/$<mo>/$<y>"));
// "16/07/2026"
```
Named group syntax `(?<name>…)` is identical in Rust; `$<name>` → `${name}`.

### RE-9 — `$&` whole-match replacement special
```ts
console.log("cat".replace(/cat/, "[$&]"));  // "[cat]"
```
`$&` → `regex` `${0}`.

### RE-10 — `s.split(re)`
```ts
const parts = "a, b,c ,  d".split(/,\s*/);
console.log(parts.length);   // 4
console.log(parts.join("|")); // "a|b|c |  d"
```
`re.split` → `Vec<String>`.

### RE-11 — `s.matchAll` iteration
```ts
let out = "";
for (const m of "a1b2".matchAll(/([a-z])(\d)/g)) {
  out += m[1] + "=" + m[2] + ";";
}
console.log(out);   // "a=1;b=2;"
```
`re.captures_all` → iterator of capture arrays; requires `g`.

### RE-12 — `s.search(re)` → char index / -1
```ts
console.log("hello world".search(/o/));   // 4
console.log("hello".search(/z/));         // -1
```
`re.search` → `f64` (char index, -1 sentinel).

### RE-13 — `new RegExp("string-literal", "flags")`
```ts
const re = new RegExp("\\d+", "g");
console.log("x9y8".match(re)!.join(","));  // "9,8"
```
String-literal first arg → same transpile-time translation as the literal.

### RE-14 — single (non-looped) `re.exec` first match
```ts
const m = /(\d+)/.exec("abc42def");
console.log(m !== null);  // true
console.log(m![1]);       // "42"
```
`re.exec` → `Option<Vec<Option<String>>>`, first match only (faithful).

### RE-15 — non-participating optional group → `undefined`
```ts
const m = "b".match(/(a)?(b)/);
console.log(m![1] === undefined);  // true
console.log(m![2]);                // "b"
```
`None` capture → JS `undefined` via the 066 Option model.

---

## Fail-loud specs (transpile-time `UnsupportedError`, message names the construct)

### RE-F1 — backreference in a literal pattern
```ts
const re = /(a)\1/;
```
→ `UnsupportedError`: backreferences are not supported by the Rust `regex`
engine (names the construct). **Never** mistranslated.

### RE-F2 — lookahead
```ts
const re = /a(?=b)/;
```
→ `UnsupportedError`: lookahead `(?=…)` is not supported by the Rust `regex`
engine.

### RE-F3 — lookbehind
```ts
const re = /(?<=a)b/;
```
→ `UnsupportedError`: lookbehind is not supported by the Rust `regex` engine.

### RE-F4 — sticky `y` flag
```ts
const re = /a/y;
```
→ `UnsupportedError`: the sticky `y` flag (stateful `lastIndex` anchoring) is
not modeled.

### RE-F5 — `d` (hasIndices) flag
```ts
const re = /a/d;
```
→ `UnsupportedError`: the `d` (match indices) flag is not modeled.

### RE-F6 — `re.lastIndex` access
```ts
const re = /a/g;
re.lastIndex = 2;
```
→ `UnsupportedError`: `RegExp.lastIndex` (stateful matching) is not modeled —
use `s.matchAll(re)`.

### RE-F7 — stateful `exec` loop
```ts
const re = /\d/g;
let m;
while ((m = re.exec("a1b2")) !== null) { console.log(m[0]); }
```
→ `UnsupportedError`: the stateful `RegExp.exec` loop is not modeled — use
`s.matchAll(re)`.

### RE-F8 — runtime-variable `RegExp` pattern (RE-PORT default A)
```ts
function build(p: string) { return new RegExp(p); }
```
→ `UnsupportedError`: a `RegExp` built from a non-literal pattern cannot be
validated against the Rust `regex` engine — inline the pattern as a literal.

### RE-F9 — function replacer (RE-FNREPL default, v1)
```ts
console.log("abc".replace(/./g, (c) => c.toUpperCase()));
```
→ `UnsupportedError`: a function replacer in `.replace` is not modeled (v1) —
use a string replacement template.

### RE-F10 — `` $` `` / `$'` replacement special
```ts
console.log("mid".replace(/mid/, "[$`|$']"));
```
→ `UnsupportedError`: the `` $` `` / `$'` replacement specials have no Rust
`regex` equivalent.
