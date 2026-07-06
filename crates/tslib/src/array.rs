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
