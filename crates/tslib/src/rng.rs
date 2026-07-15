//! Seeded, differential-stable PRNG (SplitMix64) — the Rust target of the
//! `@t2r/std` `rng(seed)` shim (series 089, #54). Hand-rolled, zero crate deps;
//! the identical algorithm is mirrored in the TS shim so the two streams match
//! bit-for-bit. Numeric args arrive as `f64` (the translator's `number`).

/// A stateful SplitMix64 generator. State is a single `u64`; all arithmetic is
/// modulo 2^64 (`wrapping_*`). Methods take `&mut self` and advance the state.
pub struct Rng {
    state: u64,
}

impl Rng {
    /// Seed the generator. Seeds are non-negative safe integers `[0, 2^53)`, so
    /// `seed as u64` matches the TS `BigInt(Math.trunc(seed)) & MASK` initial state.
    pub fn new(seed: f64) -> Rng {
        Rng { state: seed as u64 }
    }

    /// A float in `[0, 1)` — the direct `Math.random()` analog. Takes the top 53
    /// bits and divides by 2^53; both sides do the identical exact f64 op.
    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        (z >> 11) as f64 / 9007199254740992.0
    }

    /// An integer in `[min, max)` (half-open, exclusive max), one draw.
    pub fn int(&mut self, min: f64, max: f64) -> f64 {
        min + (self.next() * (max - min)).floor()
    }

    /// A uniformly chosen element, one draw. Returns an owned clone.
    pub fn pick<T: Clone>(&mut self, arr: &[T]) -> T {
        let i = (self.next() * arr.len() as f64).floor() as usize;
        arr[i].clone()
    }

    /// A **new** array, Fisher–Yates (`arr.len() - 1` draws). Does not mutate its
    /// argument.
    pub fn shuffle<T: Clone>(&mut self, arr: &[T]) -> Vec<T> {
        let mut a = arr.to_vec();
        let mut i = a.len();
        while i > 1 {
            i -= 1;
            let j = (self.next() * (i as f64 + 1.0)).floor() as usize;
            a.swap(i, j);
        }
        a
    }
}
