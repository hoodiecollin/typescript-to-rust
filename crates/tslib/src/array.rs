//! `Array.prototype` methods whose JS semantics diverge from the obvious Rust.

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
pub fn sort_default<T: ToString>(xs: &mut Vec<T>) {
    xs.sort_by(|a, b| a.to_string().cmp(&b.to_string()));
}

/// `Array.prototype.sort(cmp)` — sort in place by a JS comparator, whose numeric
/// return is mapped to an `Ordering` by its **sign** (`< 0` → the first element
/// sorts earlier, `> 0` later, `0`/`NaN` → keep order), matching the JS contract.
/// The comparator receives owned (Copy) elements, mirroring `(a, b) => …`.
pub fn sort_by<T: Copy, F: Fn(T, T) -> f64>(xs: &mut Vec<T>, cmp: F) {
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
