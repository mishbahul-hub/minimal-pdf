import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bindKeys } from "./keys";
import { getDoc, openPath, showStartScreen } from "./viewer";
import { initSettings } from "./settings";
import "./search";
import "./outline";
import "./annotate";
import "./radial";
import "./ai";

bindKeys();

// A PDF opened while the app is already running (double-click, "Open with") arrives here.
void listen<string>("open-file", (e) => void openPath(e.payload));

initSettings()
  .catch((err) => console.error(err))
  .then(async () => {
    // Launched by double-clicking a PDF: open it instead of the start screen.
    const launchFile = await invoke<string | null>("take_launch_file").catch(() => null);
    if (launchFile) await openPath(launchFile);
  })
  .finally(() => {
    if (!getDoc()) showStartScreen();
  });
