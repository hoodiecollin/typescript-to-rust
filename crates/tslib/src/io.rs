//! I/O helpers (series 100, the `@t2r/std` shim, epic #52). The emitter routes
//! every `@t2r/std` I/O intrinsic through this module (fn-first, per the
//! codegen-helper-boundary note) so behavior is written once in an audited crate
//! rather than open-coded in codegen. **Every fallible helper normalizes its
//! error to `String` at the leaf** (`map_err(|e| e.to_string())`): the emitter
//! only ever sees `Result<_, String>`, so the 049 `String`-error spine stays
//! intact (and `?` composes into a `String`- *or* `AppError`-returning fn via the
//! shipped `From<String>` impl). No Rust error *type* leaks into codegen.

use std::io::Write;

// ── Sync filesystem (fallible → `Result<_, String>`) ────────────────────────

/// `readFile(path)` — read whole file as UTF-8 text.
pub fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// `writeFile(path, data)` — truncate + write.
pub fn write_file(path: &str, data: &str) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| e.to_string())
}

/// `appendFile(path, data)` — create-or-append (std has no one-call append).
pub fn append_file(path: &str, data: &str) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

/// `removeFile(path)`.
pub fn remove_file(path: &str) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// `mkdir(path)` — recursive (matches `mkdir(p, { recursive: true })`).
pub fn mkdir(path: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// `removeDir(path)` — recursive.
pub fn remove_dir(path: &str) -> Result<(), String> {
    std::fs::remove_dir_all(path).map_err(|e| e.to_string())
}

/// `readDir(path)` — the entry file-names, **sorted** (byte order). Sorting is a
/// deliberate faithfulness rule (design §3a): native FS enumeration order is not
/// stable across platforms, so both the Bun run and the Rust run sort, observing
/// the identical list.
pub fn read_dir(path: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

// ── Sync filesystem / process (infallible) ──────────────────────────────────

/// `exists(path)` — `false` on any error (matches `existsSync`). Infallible.
pub fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

/// `env(name)` — the var's value, or `None` when unset. Infallible (absence is
/// `None`, not an error); folds into the 066 Option model.
pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `args()` — the program args **after** the binary name (matches
/// `process.argv.slice(2)`; the argv-parity note, design §7).
pub fn args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// `exit(code)` — process exit. Returns `!` (the translator's `never`).
pub fn exit(code: f64) -> ! {
    std::process::exit(code as i32)
}

// ── Standard streams ─────────────────────────────────────────────────────────

/// `readStdin()` — read **all** of stdin to EOF as UTF-8 text. Fallible.
pub fn read_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// `readLine()` — one line from stdin, **trailing newline stripped**, `None` at
/// EOF. Fallible on a genuine read error (distinct from the EOF-`None`).
pub fn read_line() -> Result<Option<String>, String> {
    let mut s = String::new();
    let n = std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut s)
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    if s.ends_with('\n') {
        s.pop();
        if s.ends_with('\r') {
            s.pop();
        }
    }
    Ok(Some(s))
}

/// A stdout/stderr `Writer` handle (series 100), the byte-precise counterpart to
/// `console.log`'s `println!` — `write` emits no trailing newline, so a fixture
/// controls the exact stream the differential diffs. Reuses the 089 stateful-
/// handle machinery (recorded binding + method routing); emitted `let mut`.
///
/// **Accepted divergence:** the methods are **infallible** (they `.expect()` on
/// the rare underlying I/O error) rather than returning `Result`. JS
/// `process.stdout.write` does not throw synchronously either, so no differential
/// observes a write error; this keeps stream handles out of the fallibility
/// fixpoint (a `console.log`-shaped surface stays `Result`-free).
pub struct Writer {
    inner: Box<dyn Write>,
}

/// `stdout()` — a [`Writer`] over `std::io::stdout()`.
pub fn stdout() -> Writer {
    Writer { inner: Box::new(std::io::stdout()) }
}

/// `stderr()` — a [`Writer`] over `std::io::stderr()`.
pub fn stderr() -> Writer {
    Writer { inner: Box::new(std::io::stderr()) }
}

impl Writer {
    /// `.write(s)` — no trailing newline.
    pub fn write(&mut self, s: &str) {
        self.inner.write_all(s.as_bytes()).expect("Writer::write");
    }

    /// `.writeLine(s)` — one trailing `\n`.
    pub fn write_line(&mut self, s: &str) {
        self.inner.write_all(s.as_bytes()).expect("Writer::writeLine");
        self.inner.write_all(b"\n").expect("Writer::writeLine");
    }

    /// `.flush()` — force the handle's buffer out.
    pub fn flush(&mut self) {
        self.inner.flush().expect("Writer::flush");
    }
}

// ── Async filesystem (`tokio::fs`, fallible → `Result<_, String>`) ───────────

/// Async `fsAsync.readFile`. Awaited (`.await?`).
pub async fn read_file_async(path: &str) -> Result<String, String> {
    tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())
}

/// Async `fsAsync.writeFile`.
pub async fn write_file_async(path: &str, data: &str) -> Result<(), String> {
    tokio::fs::write(path, data).await.map_err(|e| e.to_string())
}

/// Async `fsAsync.removeFile`.
pub async fn remove_file_async(path: &str) -> Result<(), String> {
    tokio::fs::remove_file(path).await.map_err(|e| e.to_string())
}

/// Async `fsAsync.mkdir` — recursive.
pub async fn mkdir_async(path: &str) -> Result<(), String> {
    tokio::fs::create_dir_all(path).await.map_err(|e| e.to_string())
}

/// Async twin of [`read_dir`] (`fsAsync.readDir`) over `tokio::fs`. Same sorted
/// contract.
pub async fn read_dir_async(path: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut rd = tokio::fs::read_dir(path).await.map_err(|e| e.to_string())?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}
