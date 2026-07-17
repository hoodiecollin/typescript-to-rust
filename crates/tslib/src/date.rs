//! JS `Date` fidelity — a deterministic instant algebra over `chrono::DateTime<Utc>`
//! (series 102, epic #56). All instants are UTC internally; the short local
//! accessors are UTC-normalized (`get_hours ≡ get_utc_hours`, `get_timezone_offset
//! ≡ 0`) — a documented divergence pinned airtight by the harness `TZ=UTC`. The
//! seeded [`Clock`] is the differential-stable replacement for ambient
//! `Date.now()` / no-arg `new Date()` — the `Date` analog of `rng(seed)`.
//!
//! `chrono` is used with `default-features = false, features = ["std"]` — no
//! system clock, no timezone database — so the whole surface is pure arithmetic.

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Timelike, Utc,
};

/// A JS `Date` — an instant on the UTC timeline. Constructed from epoch-ms, a
/// strict ISO-8601 string, or 0-based-month calendar fields; read back with the
/// JS accessor names; formatted with `toISOString`/`toJSON`/`toDateString`.
pub struct Date(DateTime<Utc>);

impl Date {
    /// `new Date(ms)` — milliseconds since the Unix epoch.
    pub fn from_epoch_ms(ms: f64) -> Date {
        Date(
            DateTime::from_timestamp_millis(ms as i64)
                .unwrap_or_else(|| panic!("Date: epoch ms {ms} out of range")),
        )
    }

    /// `new Date(isoString)` — strict RFC3339 (`YYYY-MM-DDTHH:mm:ss.sssZ`) or a
    /// bare `YYYY-MM-DD` (midnight UTC). Loose `Date.parse` forms are rejected at
    /// transpile time, so a bad string here is a genuine bug (panic).
    pub fn parse_iso(s: &str) -> Date {
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Date(dt.with_timezone(&Utc));
        }
        if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            return Date(d.and_hms_opt(0, 0, 0).unwrap().and_utc());
        }
        panic!("Date: unparseable ISO string {s:?}");
    }

    /// `new Date(y, m0, d, h, min, s, ms)` — `m0` is the **0-based** JS month
    /// (chrono is 1-based, so this adds 1). Interpreted as UTC.
    pub fn from_parts(y: f64, m0: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> Date {
        let base = Utc
            .with_ymd_and_hms(y as i32, m0 as u32 + 1, d as u32, h as u32, min as u32, s as u32)
            .single()
            .unwrap_or_else(|| panic!("Date: invalid calendar fields"));
        Date(base + Duration::milliseconds(ms as i64))
    }

    pub fn get_time(&self) -> f64 {
        self.0.timestamp_millis() as f64
    }
    pub fn get_full_year(&self) -> f64 {
        self.0.year() as f64
    }
    /// 0-based month (JS `getMonth`/`getUTCMonth` semantics).
    pub fn get_month(&self) -> f64 {
        self.0.month0() as f64
    }
    pub fn get_date(&self) -> f64 {
        self.0.day() as f64
    }
    /// Weekday, Sunday = 0 (JS `getDay`/`getUTCDay`).
    pub fn get_day(&self) -> f64 {
        self.0.weekday().num_days_from_sunday() as f64
    }
    pub fn get_hours(&self) -> f64 {
        self.0.hour() as f64
    }
    pub fn get_minutes(&self) -> f64 {
        self.0.minute() as f64
    }
    pub fn get_seconds(&self) -> f64 {
        self.0.second() as f64
    }
    pub fn get_milliseconds(&self) -> f64 {
        self.0.timestamp_subsec_millis() as f64
    }
    /// UTC-pinned — always 0 (the documented timezone normalization).
    pub fn get_timezone_offset(&self) -> f64 {
        0.0
    }

    /// `toISOString()` / `toJSON()` — `YYYY-MM-DDTHH:mm:ss.sssZ`. `use_z=true`
    /// prints `Z` (not `+00:00`); `Millis` forces exactly 3 fractional digits —
    /// an exact match for JS.
    pub fn to_iso_string(&self) -> String {
        self.0.to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// `toDateString()` — the fixed English `"Www Mmm DD YYYY"` form (e.g.
    /// `"Tue Nov 14 2023"`). Hand-written so it never consults a locale; the day
    /// is zero-padded to 2 digits, matching JS.
    pub fn to_date_string(&self) -> String {
        const WD: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const MO: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let wd = WD[self.0.weekday().num_days_from_sunday() as usize];
        let mo = MO[self.0.month0() as usize];
        format!("{} {} {:02} {}", wd, mo, self.0.day(), self.0.year())
    }
}

/// A seeded, differential-stable clock — the `Date` analog of `rng(seed)`. Wraps
/// an `i64` epoch-ms; `now()` reads it, `date()` bridges into the [`Date`]
/// algebra, `tick(ms)` advances it deterministically.
pub struct Clock {
    epoch_ms: i64,
}

impl Clock {
    pub fn new(epoch_ms: f64) -> Clock {
        Clock { epoch_ms: epoch_ms as i64 }
    }
    /// Milliseconds since the epoch — the seeded `Date.now()`.
    pub fn now(&self) -> f64 {
        self.epoch_ms as f64
    }
    /// A `Date` fixed at the current instant.
    pub fn date(&self) -> Date {
        Date::from_epoch_ms(self.epoch_ms as f64)
    }
    /// Advance the clock by `ms` (the honest analog of elapsed time).
    pub fn tick(&mut self, ms: f64) {
        self.epoch_ms += ms as i64;
    }
}
