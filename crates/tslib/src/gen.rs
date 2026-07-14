//! Generator consumption fidelity — the `{ value, done }` protocol (series 075).
//!
//! A JS generator's manual `it.next()` returns `{ value, done }`, a tagged union:
//! `{ value: Y, done: false }` while yielding, then `{ value: R, done: true }` at
//! completion (the `return` value). Rust's `Iterator::next()` is pull-only
//! (`Option<Y>`) and drops that terminal `R`. `GenStep<Y, R>` is the faithful
//! tagged union — a home for **both** payloads — so a generator's `return <value>`,
//! the `yield*` completion value, and a manual `{ value, done }` read all round-trip.
//!
//! Every generator struct the translator emits implements [`Steppable`], exposing
//! `step(&mut self) -> GenStep<Y, R>` alongside its `impl Iterator`. The trait lets
//! a `yield*` delegate be boxed as `Box<dyn Steppable<Y, R>>` when its completion
//! value is read (otherwise 065's `dyn Iterator` box is kept unchanged). Series 076
//! (bidirectional generators) reuses `GenStep` as the result of `resume(v)`.

/// A single step of a generator — JS's `IteratorResult<Y, R>` as a tagged union.
///
/// `Yield(v)` is `{ value: v, done: false }`; `Return(v)` is
/// `{ value: v, done: true }`. A consumer's `r.done` becomes
/// `matches!(r, GenStep::Return(_))` and its `r.value` the narrowed binding — the
/// enum has no `value`/`done` fields (that is the accepted rewrite, series 075).
pub enum GenStep<Y, R> {
    /// A yielded value — the generator is suspended, not done.
    Yield(Y),
    /// The completion value — the generator is done (`return <value>` / fall-off).
    Return(R),
}

/// Every generator struct implements this: `step()` drives the same state machine
/// as `Iterator::next` but preserves the terminal `Return(R)` payload. Boxed as
/// `Box<dyn Steppable<Y, R>>` for the `yield*`-completion-value delegate path.
pub trait Steppable<Y, R> {
    /// Advance the generator one step, preserving the completion value.
    fn step(&mut self) -> GenStep<Y, R>;
}
