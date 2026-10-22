use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalSize, State, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tauri_plugin_store::StoreExt;

/// A PDF passed on the command line (double-click / "Open with"), waiting for the frontend to ask for it.
struct LaunchFile(Mutex<Option<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch hands its arguments to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = pdf_arg(&args, Path::new(&cwd)) {
                if allow(app, &path) {
                    let _ = app.emit("open-file", path);
                }
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![allow_recent, take_launch_file])
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = pdf_arg(&args, &cwd) {
                if allow(app.handle(), &path) {
                    *app.state::<LaunchFile>().0.lock().unwrap() = Some(path);
                }
            }
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

/// The first argument (after the program) that is an existing .pdf file, made absolute.
fn pdf_arg(args: &[String], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        let p = PathBuf::from(a);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        let is_pdf = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        (is_pdf && p.is_file()).then(|| p.to_string_lossy().into_owned())
    })
}

/// Let the frontend read this one file (it didn't come from the open dialog).
fn allow(app: &AppHandle, path: &str) -> bool {
    app.fs_scope().allow_file(path).is_ok()
}

/// The PDF the app was launched with, if any. Returned once.
#[tauri::command]
fn take_launch_file(state: State<LaunchFile>) -> Option<String> {
    state.0.lock().unwrap().take()
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
