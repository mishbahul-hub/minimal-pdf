// Updates: a quiet check a few seconds after start (release builds only). When a newer version is
// published on GitHub Releases, a small prompt offers to install it; the installer restarts the app.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { registerOverlay, unregisterOverlay } from "./overlays";

const CHECK_DELAY_MS = 5000;

export function checkForUpdates() {
  if (!import.meta.env.PROD) return;
  setTimeout(async () => {
    try {
      const update = await check();
      if (update) showPrompt(update);
    } catch {
      // Offline, or no release published yet: try again next launch.
    }
  }, CHECK_DELAY_MS);
}

function showPrompt(update: Update) {
  const el = document.createElement("div");
  el.id = "update";
  el.className = "panel";
  el.innerHTML = `
    <span class="text"></span>
    <button type="button" class="install">Install and restart</button>
    <button type="button" class="later">Later</button>`;
  el.querySelector(".text")!.textContent = `Minimal PDF ${update.version} is available.`;
  document.body.append(el);
  const close = () => {
    el.remove();
    unregisterOverlay(el);
    void update.close();
  };
  registerOverlay(el, close);
  el.querySelector(".later")!.addEventListener("click", close);
  el.querySelector(".install")!.addEventListener("click", async () => {
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    el.querySelector(".text")!.textContent = "Downloading the update…";
    try {
      await update.downloadAndInstall(); // on Windows the installer closes the app and reopens it
    } catch (e) {
      el.querySelector(".text")!.textContent = `The update failed: ${e instanceof Error ? e.message : String(e)}`;
      el.querySelector<HTMLButtonElement>(".later")!.disabled = false;
    }
  });
}
