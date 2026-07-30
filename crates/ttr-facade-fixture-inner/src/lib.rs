//! Inner half of the facade-generator reference fixture (series 122).
//!
//! Exists to be **re-exported** by `ttr-facade-fixture` via `pub use`, so the
//! generator must resolve a cross-crate re-export to this crate's canonical path
//! (`ttr_facade_fixture_inner::Gadget`) — the exact capability `syn` cannot provide
//! and the reason series 122 chose rustdoc JSON. This mirrors candle's real shape
//! (`candle` re-exports `candle_core::Tensor`).

/// A gadget defined here but surfaced through the outer crate's `pub use`.
pub struct Gadget {
    pub serial: u64,
}

impl Gadget {
    /// Associated constructor — should map to a namespaced static (`Gadget.new`).
    pub fn new(serial: u64) -> Self {
        Self { serial }
    }

    /// Borrowing reader — receiver `&self`, no params.
    pub fn serial(&self) -> u64 {
        self.serial
    }
}
