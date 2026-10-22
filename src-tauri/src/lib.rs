use tauri::{AppHandle, Manager, PhysicalSize, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tauri_plugin_store::StoreExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![allow_recent])
        .setup(|app| {
            // The window starts hidden (tauri.conf.json) so it can be resized before it appears.
            if let Some(win) = app.get_webview_window("main") {
                fit_to_work_area(&win);
                win.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Let the frontend read a recent file from an earlier session. Files picked in the dialog are
/// allowed automatically, but that permission doesn't survive a restart. Only paths already in
/// the saved recent list are allowed, so this can't be used to read arbitrary files.
#[tauri::command]
fn allow_recent(app: AppHandle, path: String) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let known = store
        .get("recent")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .any(|r| r.get("path").and_then(|p| p.as_str()) == Some(path.as_str()));
    if !known {
        return Err("not a recent file".into());
    }
    app.fs_scope().allow_file(&path).map_err(|e| e.to_string())
}

/// The default size can be taller than the screen (e.g. 1080p at high scaling):
/// shrink the window to fit the monitor's work area and centre it.
fn fit_to_work_area(win: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(outer), Ok(inner)) =
        (win.current_monitor(), win.outer_size(), win.inner_size())
    else {
        return;
    };
    let area = monitor.work_area().size;
    // set_size sets the inner size, so leave room for the title bar and borders.
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);
    let width = inner.width.min(area.width.saturating_sub(frame_w));
    let height = inner.height.min(area.height.saturating_sub(frame_h));
    if (width, height) != (inner.width, inner.height) {
        let _ = win.set_size(PhysicalSize::new(width, height));
    }
    let _ = win.center();
}
