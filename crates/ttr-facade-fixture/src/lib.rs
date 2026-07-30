//! Reference fixture crate for the `ttr facade` generator (series 122) — the
//! generator's analog of `@ttr/plugin-leftpad`. Every mapping case the specs
//! (FAC5–FAC12) exercise is present here, so the checked-in rustdoc JSON of this
//! crate is the hermetic test input and this source is the single place a new case
//! is added. Intentionally quirk-heavy: a cross-crate re-export, a macro-generated
//! method, a `Result` alias, `&self`/`&mut self`/`&param`/owned borrows, an enum,
//! an associated constructor, a generic method (the reject case), and a trait that
//! is not surfaced unless `--allow-trait` names it.

pub use ttr_facade_fixture_inner::Gadget;

/// The crate's error type; the resolved `E` in the `Result` alias below.
#[derive(Debug)]
pub struct Error;

/// Crate-local `Result` alias. A method returning `Result<T>` must be recorded as
/// fallible with the **resolved** error path (`ttr_facade_fixture::Error`), not the
/// surface token `Result` — the field the D4 fallible-leaf work consumes.
pub type Result<T> = core::result::Result<T, Error>;

/// An owned type → one `declare`d TS type mapped to `ttr_facade_fixture::Widget`.
pub struct Widget {
    pub id: u32,
}

/// A unit-variant enum → namespaced constants (`Mode.Fast → …::Mode::Fast`).
pub enum Mode {
    Fast,
    Slow,
}

macro_rules! id_method {
    ($name:ident) => {
        /// Macro-generated method — no textual `fn` in source; only rustdoc's
        /// post-expansion view sees it, so its presence proves expansion happened.
        pub fn $name(&self) -> u32 {
            self.id
        }
    };
}

impl Widget {
    /// Associated constructor → namespaced static (`Widget.empty`).
    pub fn empty() -> Self {
        Widget { id: 0 }
    }

    /// Borrows: receiver `&self`, `rhs: &Widget` (borrow), `n: u32` (owned).
    pub fn combine(&self, rhs: &Widget, n: u32) -> u32 {
        self.id + rhs.id + n
    }

    /// Mutating method → receiver recorded as `&mut self`.
    pub fn bump(&mut self, by: u32) {
        self.id += by;
    }

    /// Fallible via the crate `Result` alias → fallible leaf, error `…::Error`.
    pub fn try_scale(&self, factor: u32) -> Result<Widget> {
        Ok(Widget {
            id: self.id * factor,
        })
    }

    /// Generic method the generator cannot ground to a concrete facade shape →
    /// the reference crate's negative reject case (fails loud with this item path).
    pub fn cast<T: From<u32>>(&self) -> T {
        T::from(self.id)
    }

    id_method!(raw);
}

/// A trait whose method is absent from the facade unless `--allow-trait
/// ttr_facade_fixture::Combine` is passed.
pub trait Combine {
    fn merged(&self, other: &Self) -> u32;
}

impl Combine for Widget {
    fn merged(&self, other: &Widget) -> u32 {
        self.id + other.id
    }
}
