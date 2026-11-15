# 08 · Security and privacy

## Threat model (what could go wrong)

| Threat | Mitigation in this app |
|---|---|
| API keys stolen from the app's files | Keys are only in Windows Credential Manager (OS-protected); never in `settings.json` |
| A malicious PDF exploits the renderer and runs script in the WebView | The WebView can't read keys back (no command returns them); file access is limited by Tauri capabilities |
| A key sent to the wrong server | Keys for Ollama/custom providers are stored together with their base URL, and only sent there; Rust rejects unknown provider ids |
| Prompt injection from model output into the UI | Answers are HTML-escaped before the small Markdown renderer runs; citations become buttons, not raw HTML |
| Tampered update | Updates are signed with a private key; the app verifies the signature with the public key built into it and refuses a mismatch |
| The user's PDF corrupted by the app | The PDF is read-only except "Replace original", which asks first |

## API keys: the full path

1. User pastes a key in Settings → Chat AI → **Save and test**.
2. The UI calls `invoke("ai_set_key", { providerId, key, baseUrl })`.
3. Rust stores it with the `keyring` crate in Credential Manager (service `com.islam.minimalpdf`,
   one entry per provider), after a one-word test request.
4. Later, `ai_stream` reads the key in Rust, adds the auth header (`x-api-key` for Anthropic,
   `Authorization: Bearer` for the others), and streams the response back.
5. The UI only ever learns "a key exists" (`ai_has_key`) and can remove it (`ai_clear_key`).

**Principle:** secrets stay in the most privileged, least exposed layer. The web layer handles
untrusted content (PDFs, model output), so it's the layer most at risk.

## Tauri capabilities (least privilege)

`src-tauri/capabilities/default.json` lists exactly what the UI may call: open/save/ask dialogs,
read and write files, the settings store, window title/fullscreen, the updater. There's **no static
filesystem scope**: the dialog plugin adds only the file the user picked to the allowed scope at
runtime. Paths that didn't come from a dialog (recent files, the file passed on the command line)
are allowed explicitly in Rust, and recent files only if they're already in the saved recent list.

## Signed updates

- Build: `TAURI_SIGNING_PRIVATE_KEY` (a minisign key, stored as a GitHub Actions secret) signs each
  installer; the build writes `.sig` files and a `latest.json` manifest.
- App: the **public key** is embedded in `tauri.conf.json`. On start (release builds), it fetches
  `latest.json` from GitHub Releases, downloads the installer, **verifies the signature**, and only
  then offers "Install and restart".
- If the private key is lost, existing installs can't accept future updates (they'd need a manual
  reinstall), so the key is backed up.

**Distinction to know:** update signing (integrity of updates) is different from **Windows code
signing** (Authenticode, which removes the SmartScreen "unknown publisher" warning and needs a paid
certificate). This project has the first, not yet the second.

## Privacy

- Nothing goes to an AI provider until the user asks.
- Only the question, selected text and pages the AI reads are sent; never the PDF file.
- Ollama and the offline translation models keep everything on the computer.
- No analytics or telemetry.

## Known weaknesses (say these yourself: it shows maturity)

1. **Content Security Policy is off** (`"csp": null` in `tauri.conf.json`). A strict CSP
   (`script-src 'self'`, limited `connect-src`) would reduce the impact of any script injection.
   It needs care because Transformers.js loads WASM from a CDN and fetches model files.
2. **Runtime code from a CDN:** the ONNX Runtime WASM files are fetched from jsDelivr at runtime. A
   compromised CDN could serve malicious code; pinning versions with integrity hashes or bundling
   them would be safer (at the cost of installer size).
3. **No Windows code signing**, so users see a SmartScreen warning.
4. **No automated security tests** (e.g. dependency auditing in CI with `npm audit` / `cargo audit`).
