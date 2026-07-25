//! `Array.prototype` methods whose JS semantics diverge from the obvious Rust.

use std::collections::VecDeque;

/// `Array.prototype.at` — index with JS's negative-from-the-end semantics.
///
/// `xs.at(i)`: for `i >= 0` returns `xs[i]`; for `i < 0` returns
/// `xs[len + i]` (counting from the end, so `at(-1)` is the last element). The
/// index arrives as `f64` (the translator's `number`) and is truncated toward
/// zero, matching JS's `ToIntegerOrInfinity` on a small integral index.
///
/// JS returns `undefined` for an out-of-range index; the translator's typed
/// slice assumes an in-range access, so this **panics** out of range (a loud
/// failure, never a wrong value). `Option<T>` is a later refinement.
pub fn at<T: Copy>(xs: &[T], index: f64) -> T {
    let i = index.trunc() as i64;
    let resolved = if i < 0 { xs.len() as i64 + i } else { i };
    if resolved < 0 || resolved as usize >= xs.len() {
        panic!("Array.at: index {index} out of range (len {})", xs.len());
    }
    xs[resolved as usize]
}

/// `Array.prototype.sort` — JS's default comparator, which sorts elements as
/// **strings**, in place. So `[10, 1, 2].sort()` is `[1, 10, 2]`, not
/// `[1, 2, 10]`. Confined here because Rust's `Vec::sort` needs `Ord` (which
/// `f64` lacks) and would sort numerically anyway; sorting by `.to_string()`
/// reproduces the JS lexicographic order exactly (`10.0.to_string() == "10"`).
pub fn sort_default<T: ToString>(xs: &mut [T]) {
    xs.sort_by(|a, b| a.to_string().cmp(&b.to_string()));
}

/// `Array.prototype.sort(cmp)` — sort in place by a JS comparator, whose numeric
/// return is mapped to an `Ordering` by its **sign** (`< 0` → the first element
/// sorts earlier, `> 0` later, `0`/`NaN` → keep order), matching the JS contract.
/// The comparator receives owned (Copy) elements, mirroring `(a, b) => …`.
pub fn sort_by<T: Copy, F: Fn(T, T) -> f64>(xs: &mut [T], cmp: F) {
    xs.sort_by(|a, b| {
        cmp(*a, *b)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Normalize a JS slice index against `len`: truncate toward zero, resolve a
/// negative index from the end, then clamp into `[0, len]`.
fn slice_index(i: f64, len: usize) -> usize {
    let len = len as i64;
    let i = i.trunc() as i64;
    let resolved = if i < 0 { len + i } else { i };
    resolved.clamp(0, len) as usize
}

/// `Array.prototype.slice(start, end)` — a shallow copy of `[start, end)` with
/// JS's clamping and negative-from-the-end semantics (`end` exclusive). Out-of-
/// range indices clamp rather than panic (the JS quirk); an empty range yields an
/// empty `Vec`.
pub fn slice<T: Clone>(xs: &[T], start: f64, end: f64) -> Vec<T> {
    let s = slice_index(start, xs.len());
    let e = slice_index(end, xs.len());
    if e <= s {
        Vec::new()
    } else {
        xs[s..e].to_vec()
    }
}

/// `Array.prototype.slice(start)` — the end-omitted form, copying from `start`
/// through the end of the array.
pub fn slice_from<T: Clone>(xs: &[T], start: f64) -> Vec<T> {
    let s = slice_index(start, xs.len());
    xs[s..].to_vec()
}

/// `Array.prototype.join(sep)` — JS coerces each element to its string form and
/// joins with `sep`. `[T]::join` needs `T: Borrow<str>` (string-only); this joins
/// **any** `ToString` element (so a number array yields `"1-2-3"`), matching JS.
/// A number element uses `tslib::number::to_js_string` fidelity via a `f64`
/// specialization would be ideal, but `ToString` on `f64` already renders `1`
/// (not `1.0`) for integrals through `Display`… except it does not — so callers
/// pass string/number arrays whose `Display` matches JS for the common integral
/// and fractional cases (documented divergence at magnitude edges, per 083).
pub fn join<T: ToString>(xs: &[T], sep: &str) -> String {
    xs.iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(sep)
}

/// `Array.prototype.concat(ys)` — a **new** array with `ys` appended (the JS
/// receiver is unchanged; concat returns a fresh array). Both are cloned in.
pub fn concat<T: Clone>(xs: &[T], ys: &[T]) -> Vec<T> {
    let mut out = xs.to_vec();
    out.extend_from_slice(ys);
    out
}

/// `Array.prototype.flat()` (default depth 1) — flatten one level of an
/// array-of-arrays into a new `Vec`. Deep `flat(n)` is a later slice.
pub fn flat<T: Clone>(xss: &[Vec<T>]) -> Vec<T> {
    let mut out = Vec::new();
    for inner in xss {
        out.extend_from_slice(inner);
    }
    out
}

/// `Array.prototype.splice(start, deleteCount, ...items)` (series 116) — remove
/// `deleteCount` elements at `start`, insert `items` in their place, and **return
/// the removed elements** as a new `Vec` (JS's return value). `start` uses JS
/// clamping + negative-from-the-end semantics; `deleteCount` clamps to
/// `[0, len - start]`. The hairy `drain`+`insert` index math lives here (one tested
/// fn) rather than in the emitter. `items` is passed owned (the variadic inserts
/// collected into a `Vec`); an insert-only splice passes an empty `Vec`.
pub fn splice<T: Clone>(xs: &mut Vec<T>, start: f64, delete_count: f64, items: Vec<T>) -> Vec<T> {
    let len = xs.len();
    let s = slice_index(start, len);
    let max_del = len - s;
    let d = if delete_count < 0.0 {
        0
    } else {
        (delete_count.trunc() as usize).min(max_del)
    };
    xs.splice(s..s + d, items).collect()
}

/// Vec↔VecDeque interop (series 116) — the shared bridge used wherever a
/// front-mutated `VecDeque` array meets a `Vec`-shaped op (`sort`/`join`/`concat`/
/// `flat`/a `&[T]` slice) or a `&Vec<T>` boundary, so a `VecDeque` stays first-class
/// instead of carving a hole. `as_slice_mut` sorts/mutates in place (no realloc);
/// `to_vec` borrows a fresh contiguous copy; `from_vec` seeds a deque literal.
pub fn deque_as_slice_mut<T>(d: &mut VecDeque<T>) -> &mut [T] {
    d.make_contiguous()
}

/// A fresh contiguous `Vec` copy of a `VecDeque` (for a `&Vec<T>`/`&[T]` boundary).
pub fn deque_to_vec<T: Clone>(d: &VecDeque<T>) -> Vec<T> {
    d.iter().cloned().collect()
}

/// Seed a `VecDeque` from an array literal's `Vec` (the construction site of a
/// front-mutated array — `VecDeque::from` is O(1) but centralized here for clarity).
pub fn deque_from_vec<T>(v: Vec<T>) -> VecDeque<T> {
    VecDeque::from(v)
}

/// `Array.prototype.splice` over a front-mutated `VecDeque` (series 116) — `VecDeque`
/// has no `splice`, so take the buffer, splice as a `Vec`, and restore. Returns the
/// removed elements like the `Vec` form.
pub fn deque_splice<T: Clone>(
    d: &mut VecDeque<T>,
    start: f64,
    delete_count: f64,
    items: Vec<T>,
) -> Vec<T> {
    let mut v: Vec<T> = std::mem::take(d).into();
    let removed = splice(&mut v, start, delete_count, items);
    *d = VecDeque::from(v);
    removed
}
