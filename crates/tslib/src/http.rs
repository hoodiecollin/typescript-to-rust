//! HTTP client helpers (series 100, the `@t2r/std` shim, epic #52). A minimal,
//! typed surface — GET/POST of **text bodies only** (no header maps, no
//! streaming, no multipart) — over `reqwest` (async, rustls TLS so there is no
//! system-OpenSSL dependency). Composes with the 051 tokio runtime; both calls
//! are fallible + awaited (`.await?`). Every error is normalized to `String` at
//! the leaf, preserving the 049 `String`-error spine.

/// The response of an [`get`]/[`post`] call — a purpose-built std-shim type (the
/// 084 `ParseResult` precedent: the dialect has no generic/payload enum to model
/// a rich response). `status`/`ok` are public fields; `body` is a `self`-
/// consuming accessor (read once). Mirrors the TS `HttpResponse` class in
/// `@t2r/std` so the differential oracle observes identical `.status`/`.ok`/
/// `.body`.
pub struct HttpResponse {
    /// The HTTP status code (e.g. `200`) as the translator's `number`.
    pub status: f64,
    /// `true` for a `200..=299` status (`Response.ok`).
    pub ok: bool,
    body: String,
}

impl HttpResponse {
    /// The response body text (`res.body`). `self`-consuming — the design models
    /// it as a read-once accessor.
    pub fn body(self) -> String {
        self.body
    }
}

/// `http.get(url)` → `reqwest::get`. Fallible (connection/DNS → `Err`/throw),
/// awaited (`.await?`).
pub async fn get(url: &str) -> Result<HttpResponse, String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16() as f64;
    let ok = resp.status().is_success();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, ok, body })
}

/// `http.post(url, body)` — POST a text body. Fallible, awaited (`.await?`).
pub async fn post(url: &str, body: &str) -> Result<HttpResponse, String> {
    let resp = reqwest::Client::new()
        .post(url)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16() as f64;
    let ok = resp.status().is_success();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, ok, body })
}
