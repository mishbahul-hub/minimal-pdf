//! Claude API proxy. The frontend builds each Messages API request; Rust adds the API key (kept in the
//! OS credential store, never handed back to the webview), streams the response and forwards every
//! server-sent event's JSON to the frontend over a channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const KEYRING_SERVICE: &str = "com.islam.minimalpdf";
const KEYRING_USER: &str = "anthropic-api-key";
/// Sent on the channel after the last event, so the frontend knows nothing else is coming.
const DONE: &str = "[DONE]";

/// Running streams, by the frontend's request id, so they can be cancelled.
#[derive(Default)]
pub struct Streams(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize)]
pub struct AiError {
    /// no_key, auth, rate_limit, overloaded, network, api, cancelled
    kind: &'static str,
    message: String,
}

fn err(kind: &'static str, message: impl Into<String>) -> AiError {
    AiError {
        kind,
        message: message.into(),
    }
}

fn entry() -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| err("api", e.to_string()))
}

fn stored_key() -> Option<String> {
    // Development only: tests can supply a key without touching the real credential store.
    #[cfg(debug_assertions)]
    if let Ok(k) = std::env::var("MINIMALPDF_AI_KEY") {
        return Some(k);
    }
    entry().ok()?.get_password().ok().filter(|k| !k.is_empty())
}

fn api_url() -> String {
    // Development only: point the app at a local mock server for tests.
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("MINIMALPDF_AI_BASE_URL") {
        return format!("{}/v1/messages", base.trim_end_matches('/'));
    }
    API_URL.to_string()
}

#[tauri::command]
pub fn ai_has_key() -> bool {
    stored_key().is_some()
}

#[tauri::command]
pub fn ai_set_key(key: String) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(err("no_key", "The key is empty."));
    }
    entry()?
        .set_password(key)
        .map_err(|e| err("api", e.to_string()))
}

#[tauri::command]
pub fn ai_clear_key() -> Result<(), AiError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err("api", e.to_string())),
    }
}

#[tauri::command]
pub fn ai_cancel(streams: State<'_, Streams>, request_id: String) {
    if let Some(flag) = streams.0.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// POST one streaming Messages API request (`body` is the JSON the frontend built) and forward each
/// event's `data` JSON on `on_event`, then `[DONE]`.
#[tauri::command]
pub async fn ai_stream(
    streams: State<'_, Streams>,
    request_id: String,
    body: String,
    betas: Vec<String>,
    on_event: Channel<String>,
) -> Result<(), AiError> {
    let key = stored_key().ok_or_else(|| err("no_key", "Add your Claude API key first."))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    streams
        .0
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancelled.clone());
    let result = stream(&key, body, &betas, &on_event, &cancelled).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

async fn stream(
    key: &str,
    body: String,
    betas: &[String],
    on_event: &Channel<String>,
    cancelled: &AtomicBool,
) -> Result<(), AiError> {
    let mut req = reqwest::Client::new()
        .post(api_url())
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .body(body);
    if !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    let mut res = req.send().await.map_err(|e| {
        err(
            "network",
            format!("Couldn't reach Claude. Check your internet connection. ({e})"),
        )
    })?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
            .unwrap_or(text);
        return Err(match status.as_u16() {
            401 | 403 => err("auth", "Claude rejected the API key. Check it with Ctrl+,."),
            429 => err(
                "rate_limit",
                "Too many requests right now. Wait a moment and try again.",
            ),
            529 => err(
                "overloaded",
                "Claude is busy right now. Try again in a moment.",
            ),
            _ => err(
                "api",
                format!("Claude API error {}: {detail}", status.as_u16()),
            ),
        });
    }

    // Server-sent events: blocks separated by a blank line; the JSON is on the `data:` lines.
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(err("cancelled", "Stopped."));
        }
        let chunk = res.chunk().await.map_err(|e| {
            err(
                "network",
                format!("The connection to Claude was interrupted. ({e})"),
            )
        })?;
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(end) = event_end(&buf) {
            let block: Vec<u8> = buf.drain(..end.1).collect();
            let block = String::from_utf8_lossy(&block[..end.0]);
            let data: Vec<&str> = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() {
                let _ = on_event.send(data.join("\n"));
            }
        }
    }
    let _ = on_event.send(DONE.into());
    Ok(())
}

/// End of the first complete event in `buf`: (length of the event, length including the separator).
fn event_end(buf: &[u8]) -> Option<(usize, usize)> {
    for i in 0..buf.len() {
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some((i, i + 4));
        }
        if buf[i..].starts_with(b"\n\n") {
            return Some((i, i + 2));
        }
    }
    None
}
