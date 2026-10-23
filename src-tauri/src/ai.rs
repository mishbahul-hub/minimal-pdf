//! AI provider proxy. The frontend builds each request body; Rust adds the provider's API key (kept in
//! the OS credential store, never handed back to the webview), sends it to that provider's endpoint,
//! and forwards every server-sent event's JSON to the frontend over a channel.
//!
//! Two protocols: Anthropic Messages (`anthropic`), and OpenAI-compatible Chat Completions for every
//! other provider (Gemini, Groq, Hugging Face, OpenRouter, Ollama, or a custom URL).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const KEYRING_SERVICE: &str = "com.islam.minimalpdf";
/// Sent on the channel after the last event, so the frontend knows nothing else is coming.
const DONE: &str = "[DONE]";

/// Known providers: id, display name, API base URL (None = the user supplies it).
const PROVIDERS: &[(&str, &str, Option<&str>)] = &[
    ("anthropic", "Claude", Some("https://api.anthropic.com/v1")),
    (
        "gemini",
        "Gemini",
        Some("https://generativelanguage.googleapis.com/v1beta/openai"),
    ),
    ("groq", "Groq", Some("https://api.groq.com/openai/v1")),
    (
        "huggingface",
        "Hugging Face",
        Some("https://router.huggingface.co/v1"),
    ),
    (
        "openrouter",
        "OpenRouter",
        Some("https://openrouter.ai/api/v1"),
    ),
    ("ollama", "Ollama", Some("http://localhost:11434/v1")),
    ("custom", "The AI provider", None),
];

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

/// What is saved per provider. The base URL is kept next to the key (Ollama, custom), so a key is
/// only ever sent to the address it was saved with.
#[derive(Serialize, Deserialize, Default)]
struct Credential {
    key: String,
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
}

struct Provider {
    id: &'static str,
    name: &'static str,
    base: Option<&'static str>,
}

fn provider(id: &str) -> Result<Provider, AiError> {
    PROVIDERS
        .iter()
        .find(|p| p.0 == id)
        .map(|&(id, name, base)| Provider { id, name, base })
        .ok_or_else(|| err("api", format!("Unknown AI provider \"{id}\".")))
}

impl Provider {
    fn anthropic(&self) -> bool {
        self.id == "anthropic"
    }

    /// Providers that work without a key (a local server, or a custom endpoint that needs none).
    fn key_optional(&self) -> bool {
        matches!(self.id, "ollama" | "custom")
    }

    fn entry(&self) -> Result<keyring::Entry, AiError> {
        // Claude's key keeps the entry name it had before other providers existed.
        let user = if self.anthropic() {
            "anthropic-api-key".to_string()
        } else {
            format!("api-key-{}", self.id)
        };
        keyring::Entry::new(KEYRING_SERVICE, &user).map_err(|e| err("api", e.to_string()))
    }

    fn credential(&self) -> Option<Credential> {
        // Development only: tests can supply a key without touching the real credential store.
        #[cfg(debug_assertions)]
        if let Ok(key) = std::env::var("MINIMALPDF_AI_KEY") {
            return Some(Credential {
                key,
                base_url: None,
            });
        }
        let saved = self.entry().ok()?.get_password().ok()?;
        if self.anthropic() {
            return Some(Credential {
                key: saved,
                base_url: None,
            })
            .filter(|c| !c.key.is_empty());
        }
        serde_json::from_str(&saved).ok()
    }

    /// The API base URL (no trailing slash), e.g. https://api.groq.com/openai/v1.
    fn base(&self, cred: &Credential) -> Result<String, AiError> {
        // Development only: point every provider at a local mock server for tests.
        #[cfg(debug_assertions)]
        if let Ok(base) = std::env::var("MINIMALPDF_AI_BASE_URL") {
            return Ok(format!("{}/v1", base.trim_end_matches('/')));
        }
        cred.base_url
            .as_deref()
            .or(self.base)
            .map(|b| b.trim_end_matches('/').to_string())
            .ok_or_else(|| err("no_key", "Add the provider's address first (Ctrl+,)."))
    }

    fn request(
        &self,
        method: reqwest::Method,
        url: String,
        cred: &Credential,
    ) -> reqwest::RequestBuilder {
        let req = reqwest::Client::new().request(method, url);
        if self.anthropic() {
            req.header("x-api-key", &cred.key)
                .header("anthropic-version", ANTHROPIC_VERSION)
        } else if cred.key.is_empty() {
            req
        } else {
            req.bearer_auth(&cred.key)
        }
    }

    fn require_credential(&self) -> Result<Credential, AiError> {
        self.credential().ok_or_else(|| {
            err(
                "no_key",
                format!("Add your {} API key first (Ctrl+,).", self.name),
            )
        })
    }

    /// Turn an error response into a clear message.
    async fn error(&self, res: reqwest::Response) -> AiError {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let json = serde_json::from_str::<serde_json::Value>(&text).ok();
        // { error: { message } }, or Gemini's [{ error: { message } }]
        let detail = json
            .as_ref()
            .and_then(|v| {
                v["error"]["message"]
                    .as_str()
                    .or(v[0]["error"]["message"].as_str())
            })
            .map(str::to_owned)
            .unwrap_or(text);
        let name = self.name;
        match status {
            401 | 403 => err(
                "auth",
                format!("{name} rejected the API key. Check it with Ctrl+,."),
            ),
            429 => err(
                "rate_limit",
                format!(
                    "{name}: too many requests right now (free tiers have per-minute limits). Wait a moment and try again."
                ),
            ),
            503 | 529 => err(
                "overloaded",
                format!("{name} is busy right now. Try again in a moment."),
            ),
            _ => err("api", format!("{name} error {status}: {detail}")),
        }
    }
}

#[tauri::command]
pub fn ai_has_key(provider_id: String) -> bool {
    provider(&provider_id).is_ok_and(|p| p.credential().is_some())
}

#[tauri::command]
pub fn ai_set_key(
    provider_id: String,
    key: String,
    base_url: Option<String>,
) -> Result<(), AiError> {
    let p = provider(&provider_id)?;
    let key = key.trim().to_string();
    if key.is_empty() && !p.key_optional() {
        return Err(err("no_key", "The key is empty."));
    }
    let base_url = base_url
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty());
    if let Some(u) = &base_url {
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err(err(
                "api",
                "The address must start with http:// or https://.",
            ));
        }
    } else if p.base.is_none() {
        return Err(err("api", "Enter the provider's address (base URL)."));
    }
    let value = if p.anthropic() {
        key
    } else {
        // Only Ollama and custom endpoints take an address from the user.
        let base_url = if p.key_optional() { base_url } else { None };
        serde_json::to_string(&Credential { key, base_url })
            .map_err(|e| err("api", e.to_string()))?
    };
    p.entry()?
        .set_password(&value)
        .map_err(|e| err("api", e.to_string()))
}

#[tauri::command]
pub fn ai_clear_key(provider_id: String) -> Result<(), AiError> {
    match provider(&provider_id)?.entry()?.delete_credential() {
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

/// The models the provider offers (its `GET /models` list), sorted.
#[tauri::command]
pub async fn ai_models(provider_id: String) -> Result<Vec<String>, AiError> {
    let p = provider(&provider_id)?;
    let cred = p.require_credential()?;
    let url = format!("{}/models", p.base(&cred)?);
    let res = p
        .request(reqwest::Method::GET, url, &cred)
        .send()
        .await
        .map_err(|e| err("network", format!("Couldn't reach {}. ({e})", p.name)))?;
    if !res.status().is_success() {
        return Err(p.error(res).await);
    }
    let text = res
        .text()
        .await
        .map_err(|e| err("network", e.to_string()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| err("api", e.to_string()))?;
    let mut ids: Vec<String> = json["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str())
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// POST one streaming request (`body` is the JSON the frontend built) to the provider and forward
/// each event's `data` JSON on `on_event`, then `[DONE]`.
#[tauri::command]
pub async fn ai_stream(
    streams: State<'_, Streams>,
    request_id: String,
    provider_id: String,
    body: String,
    betas: Vec<String>,
    on_event: Channel<String>,
) -> Result<(), AiError> {
    let p = provider(&provider_id)?;
    let cred = p.require_credential()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    streams
        .0
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancelled.clone());
    let result = stream(&p, &cred, body, &betas, &on_event, &cancelled).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

async fn stream(
    p: &Provider,
    cred: &Credential,
    body: String,
    betas: &[String],
    on_event: &Channel<String>,
    cancelled: &AtomicBool,
) -> Result<(), AiError> {
    let path = if p.anthropic() {
        "messages"
    } else {
        "chat/completions"
    };
    let url = format!("{}/{path}", p.base(cred)?);
    let mut req = p
        .request(reqwest::Method::POST, url, cred)
        .header("content-type", "application/json")
        .body(body);
    if p.anthropic() && !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    let mut res = req.send().await.map_err(|e| {
        let hint = if p.id == "ollama" {
            "Is Ollama running?"
        } else {
            "Check your internet connection."
        };
        err(
            "network",
            format!("Couldn't reach {}. {hint} ({e})", p.name),
        )
    })?;
    if !res.status().is_success() {
        return Err(p.error(res).await);
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
                format!("The connection to {} was interrupted. ({e})", p.name),
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
