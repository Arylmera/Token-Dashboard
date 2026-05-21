// Tauri shell. Single process: spawns the embedded axum server inside
// the Tauri runtime, points a webview at the bound localhost URL, owns
// the tray.
//
// Replaces the python+Electron stack from 3.x. The server is the same
// code the headless `token-dashboard` cli runs — we link
// `token-dashboard-cli` as a library and call `app(state)` directly,
// so there's no subprocess to spawn or kill.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// Serializes widget-window creation. `get_webview_window("widget")`
// only flips to Some after `build()` finishes on the main thread, so
// concurrent callers (reconciler tick + tray click + restore) used to
// race past the existence guard and build two windows. The flag is
// flipped on before build and back off after, regardless of result.
static WIDGET_SPAWNING: AtomicBool = AtomicBool::new(false);

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use token_dashboard_cli::{
    app as build_router, spawn_remote_sync_loop, spawn_scan_loop, spawn_startup_oauth_sync,
    AppState,
};
use token_dashboard_core::{default_db_path, Pricing};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const SCAN_INTERVAL: Duration = Duration::from_secs(10);
/// Cadence for the read-only multi-machine sync fan-out — see
/// `docs/todo/11-multi-machine-sync.md`. Strictly machine-to-machine
/// (user-owned); the manual "Sync now" button covers immediate refresh.
const REMOTE_SYNC_INTERVAL: Duration = Duration::from_secs(300);

fn projects_dir_default() -> PathBuf {
    let mut p = default_db_path();
    p.pop();
    p.join("projects")
}

fn frontend_static_dir(context: &tauri::Context) -> Option<PathBuf> {
    // Bundled installs ship the frontend as Tauri resources (see
    // `bundle.resources` in tauri.conf.json). Use Tauri's resource_dir
    // resolver — handles the platform layout differences (Windows MSI
    // installs alongside the exe, macOS bundles under
    // `Contents/Resources/`, Linux debs under `/usr/lib/<app>/`).
    if let Ok(res) =
        tauri::utils::platform::resource_dir(context.package_info(), &tauri::utils::Env::default())
    {
        let candidate = res.join("frontend");
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
    }
    // Fallback for `cargo run` scenarios: walk upward from the exe
    // looking for the in-repo `frontend/` dir, then check the cwd.
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            let candidate = dir.join("frontend").join("index.html");
            if candidate.exists() {
                return Some(dir.join("frontend"));
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    let cwd = std::env::current_dir().ok()?;
    let candidate = cwd.join("frontend");
    if candidate.join("index.html").exists() {
        Some(candidate)
    } else {
        None
    }
}

async fn pick_free_port() -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

async fn wait_for_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > READY_TIMEOUT {
            return Err(format!(
                "backend did not become ready within {}s",
                READY_TIMEOUT.as_secs()
            ));
        }
        let ok = tokio::task::spawn_blocking({
            let url = url.clone();
            move || {
                ureq::get(&url)
                    .timeout(Duration::from_millis(800))
                    .call()
                    .is_ok()
            }
        })
        .await
        .unwrap_or(false);
        if ok {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Show the main window, recreating it if it was destroyed.
/// On every platform the close handler hides the main window instead of
/// destroying it, so the fast path just calls show/unminimize/focus.
/// The rebuild path is a fallback for any code (or future platform
/// quirk) that lets the window get torn down.
fn show_or_spawn_main(app: &AppHandle, base_url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        // Reset geometry so the dashboard doesn't reappear stranded
        // behind/under the widget at its last position.
        let _ = w.set_size(tauri::LogicalSize::new(1280.0, 800.0));
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let glass_on = app
        .try_state::<GlassState>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(false);
    let load_url = format!("{base_url}/");
    let Ok(parsed) = load_url.parse() else {
        eprintln!("show_or_spawn_main: bad url {load_url}");
        return;
    };
    let bg = if glass_on {
        tauri::utils::config::Color(0, 0, 0, 0)
    } else {
        tauri::utils::config::Color(0x0a, 0x0a, 0x0a, 0xff)
    };
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("Token Dashboard")
        .inner_size(1280.0, 800.0)
        .min_inner_size(380.0, 200.0)
        .background_color(bg)
        .decorations(false)
        .visible(true);
    #[cfg(target_os = "windows")]
    let builder = builder.transparent(true);
    match builder.build() {
        Ok(win) => {
            if glass_on {
                apply_glass(&win, true);
            }
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("show_or_spawn_main: build failed: {e}"),
    }
}

fn build_tray(app: &AppHandle, base_url: &str) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
    let widget_item = MenuItem::with_id(app, "widget", "Show Widget", true, None::<&str>)?;
    let scan_item = MenuItem::with_id(app, "scan", "Scan now", true, None::<&str>)?;
    let browser_item = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &widget_item,
            &scan_item,
            &browser_item,
            &quit_item,
        ],
    )?;

    let url = base_url.to_string();
    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Token Dashboard")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // The default_window_icon comes from `tauri.conf.json`'s
            // `bundle.icon`. If absent, fall back to an empty 1×1 image
            // so the tray still appears (admin can replace via assets).
            tauri::image::Image::new_owned(vec![0; 4], 1, 1)
        }))
        .on_menu_event({
            let url = url.clone();
            move |app: &AppHandle, event: MenuEvent| match event.id.as_ref() {
                "show" => show_or_spawn_main(app, &url),
                "widget" => {
                    let _ = spawn_widget(app, &url);
                }
                "scan" => {
                    let scan_url = format!("{url}/api/scan");
                    tokio::spawn(async move {
                        let _ = tokio::task::spawn_blocking(move || {
                            ureq::get(&scan_url)
                                .timeout(Duration::from_secs(30))
                                .call()
                                .ok()
                        })
                        .await;
                    });
                }
                "browser" => open_browser(&url),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event({
            let url = url.clone();
            move |tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    }
                ) {
                    show_or_spawn_main(tray.app_handle(), &url);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Apply native window translucency. macOS uses NSVisualEffectMaterial
/// vibrancy; Windows 11 uses Acrylic. Linux is a no-op (CSS-only
/// fallback) — webkit2gtk doesn't surface a stable native effect.
fn apply_glass(win: &tauri::WebviewWindow, on: bool) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        if on {
            let _ = apply_vibrancy(
                win,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            );
        } else {
            let _ = window_vibrancy::clear_vibrancy(win);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};
        if on {
            // Prefer Mica on Win11: cleaner wallpaper blur, no acrylic
            // desat/noise layer that ends up looking flat gray when the
            // panel-opacity slider is near 0. Fall back to Acrylic on
            // older builds (Win10, Win11 pre-22H2) where Mica is absent.
            if apply_mica(win, None).is_err() {
                if let Err(e) = apply_acrylic(win, Some((0, 0, 0, 0))) {
                    eprintln!("apply_mica + apply_acrylic both failed: {e}");
                }
            }
        } else {
            let _ = clear_mica(win);
            let _ = clear_acrylic(win);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = (win, on);
    }
}

/// Spawn a tokio task that refreshes the tray tooltip every 5s with the
/// currently-selected badge metric. The `badge_metric` preference picks
/// which value to show (tokens, cost, burn, 5h, weekly); /api/overview
/// provides the raw numbers.
/// Reconcile the widget window with the `widget_open` preference.
/// The frontend toggles open/close by writing the flag through
/// /api/preferences, so the tauri shell doesn't depend on the
/// webview-side IPC bridge (which is brittle for remote-URL webviews
/// when permissions or capability scopes get out of sync).
fn spawn_widget_reconciler(app: AppHandle, base_url: String) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let db_path = match app.try_state::<DbPath>() {
                Some(s) => s.0.clone(),
                None => continue,
            };
            let want_open = tokio::task::spawn_blocking(move || {
                token_dashboard_core::preferences::get_widget_open(db_path.as_path())
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            let is_open = app.get_webview_window("widget").is_some();
            if want_open && !is_open {
                if let Err(e) = spawn_widget(&app, &base_url) {
                    eprintln!("reconcile spawn_widget: {e}");
                }
            } else if !want_open && is_open {
                if let Some(win) = app.get_webview_window("widget") {
                    let _ = win.close();
                }
            }
        }
    });
}

/// Subscribe to the embedded server's SSE stream and fire an OS notification
/// for every `budget_alert` event. The CLI emits these from
/// `run_scan_and_broadcast` after `core::budget_alerts::check` flags newly
/// crossed thresholds, so this listener does no detection itself — it just
/// surfaces what the core already decided.
///
/// Reconnects with a short backoff if the stream drops (process restart,
/// laptop sleep, etc.). The server-side budget_alert state is persisted, so
/// a missed event isn't dropped silently — it'll re-fire on the next scan
/// only if `core::budget_alerts::check` records a new crossing.
fn spawn_budget_alert_listener(app: AppHandle, base_url: String) {
    tokio::task::spawn_blocking(move || loop {
        let url = format!("{base_url}/api/stream");
        let resp = match ureq::get(&url).call() {
            Ok(r) => r,
            Err(_) => {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
        };
        let reader = std::io::BufReader::new(resp.into_reader());
        use std::io::BufRead;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Some(payload) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("budget_alert") {
                continue;
            }
            handle_budget_alert(&app, &v);
        }
        // Stream ended (server restart or transient drop). Brief pause then reconnect.
        std::thread::sleep(Duration::from_secs(2));
    });
}

fn handle_budget_alert(app: &AppHandle, v: &serde_json::Value) {
    use tauri_plugin_notification::NotificationExt;
    let crossed = v
        .get("newly_crossed")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let window = v
        .get("window")
        .and_then(|w| w.as_str())
        .unwrap_or("monthly");
    for t in crossed {
        let Some(pct) = t.as_u64() else { continue };
        let (title, body) = match window {
            "weekly" => {
                let used = v.get("percent").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let body = match v.get("resets_at").and_then(|x| x.as_str()) {
                    Some(r) => format!("{used:.0}% of weekly limit used · resets {r}"),
                    None => format!("{used:.0}% of weekly limit used"),
                };
                (format!("Token Dashboard — {pct}% of weekly limit"), body)
            }
            "five_hour" => {
                let used = v.get("percent").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let body = match v.get("resets_at").and_then(|x| x.as_str()) {
                    Some(r) => format!("{used:.0}% of 5h window used · resets {r}"),
                    None => format!("{used:.0}% of 5h window used"),
                };
                (format!("Token Dashboard — {pct}% of 5h window"), body)
            }
            _ => {
                let mtd = v
                    .get("mtd_cost_usd")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(0.0);
                let budget = v.get("monthly_budget_usd").and_then(|x| x.as_f64());
                let body = match budget {
                    Some(b) => format!("${mtd:.2} of ${b:.2} this month"),
                    None => format!("${mtd:.2} spent this month"),
                };
                (format!("Token Dashboard — {pct}% of budget"), body)
            }
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn spawn_tray_updater(app: AppHandle, base_url: String) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let prefs_url = format!("{base_url}/api/preferences");
            let overview_url = format!("{base_url}/api/overview");
            let snapshot =
                tokio::task::spawn_blocking(move || -> Option<(String, serde_json::Value)> {
                    let prefs: serde_json::Value = ureq::get(&prefs_url)
                        .timeout(Duration::from_secs(2))
                        .call()
                        .ok()?
                        .into_json()
                        .ok()?;
                    let overview: serde_json::Value = ureq::get(&overview_url)
                        .timeout(Duration::from_secs(2))
                        .call()
                        .ok()?
                        .into_json()
                        .ok()?;
                    let metric = prefs
                        .get("badge_metric")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tokens")
                        .to_string();
                    Some((metric, overview))
                })
                .await
                .ok()
                .flatten();
            let Some((metric, overview)) = snapshot else {
                continue;
            };
            let display = format_metric(&metric, &overview);
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(format!("Token Dashboard\n{display}")));
            }
            // macOS: also push the metric onto the dock badge. Tauri's
            // set_badge_label is a no-op on Windows/Linux, so we always
            // call it but the text only appears on macOS.
            apply_dock_badge(&app, &display);
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_dock_badge(app: &AppHandle, label: &str) {
    let _ = app.set_dock_visibility(true);
    // Trim very long labels — the dock can only render a handful of
    // glyphs before they get clipped.
    let trimmed: String = label.chars().take(8).collect();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_label(Some(trimmed));
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_dock_badge(_app: &AppHandle, _label: &str) {
    // Other platforms surface the same info via the tray tooltip.
}

/// Format the chosen badge_metric for display in the tray tooltip.
/// Mirrors the python tray's display logic.
fn format_metric(metric: &str, overview: &serde_json::Value) -> String {
    fn fmt_int(n: i64) -> String {
        // Thousands grouping with `,` — matches python f"{n:,}".
        let s = n.to_string();
        let bytes = s.as_bytes();
        let neg = bytes.first() == Some(&b'-');
        let digits = if neg { &s[1..] } else { &s };
        let mut out = String::new();
        for (count, c) in digits.chars().rev().enumerate() {
            if count > 0 && count % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        let formatted: String = out.chars().rev().collect();
        if neg {
            format!("-{formatted}")
        } else {
            formatted
        }
    }

    match metric {
        "cost" => {
            let usd = overview
                .get("cost_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            format!("${usd:.2}")
        }
        // "tokens" is the default; any unknown metric falls into the same
        // branch (matches python tray.js behaviour).
        _ => {
            let inp = overview
                .get("input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let out = overview
                .get("output_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let total = inp + out;
            format!("{} tokens", fmt_int(total))
        }
    }
}

/// Persist whether the widget window is currently open. Best-effort:
/// errors are logged but not propagated — failing to write the flag
/// just means the widget won't auto-restore next launch.
fn persist_widget_open(app: &AppHandle, open: bool) {
    if let Some(state) = app.try_state::<DbPath>() {
        if let Err(e) = token_dashboard_core::preferences::set_widget_open(state.0.as_path(), open)
        {
            eprintln!("persist widget_open={open}: {e}");
        }
    }
}

/// Compact always-on-top widget window. Reuses the same web bundle as
/// the main shell — `entry.jsx` sees the `#widget` URL fragment and
/// mounts the Widget component instead of the full dashboard.
fn spawn_widget(app: &AppHandle, base_url: &str) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("widget") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        persist_widget_open(app, true);
        return Ok(());
    }
    // If another caller is mid-build, don't start a second one — the
    // window registry won't show the in-flight window yet, so the
    // existence guard above can't catch this case.
    if WIDGET_SPAWNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = spawn_widget_inner(app, base_url);
    WIDGET_SPAWNING.store(false, Ordering::SeqCst);
    result
}

fn spawn_widget_inner(app: &AppHandle, base_url: &str) -> tauri::Result<()> {
    // Reuse the main `/` route (served by ServeDir's index) and pick the
    // widget mount via a hash fragment that `entry.jsx` reads. Avoids the
    // `/web/widget.html` path, which on some setups intermittently 404s
    // and surfaces a Chromium error page as a second window.
    let url = format!("{base_url}/#widget");
    let parsed: tauri::Url = url.parse().expect("widget url parse");
    let glass_on = app
        .try_state::<GlassState>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(false);
    // Bg color must match the glass state at build time — set_background_color
    // doesn't always repaint a hidden initial frame on Windows.
    let bg = if glass_on {
        tauri::utils::config::Color(0, 0, 0, 0)
    } else {
        tauri::utils::config::Color(0x0a, 0x0a, 0x0a, 0xff)
    };
    let builder = WebviewWindowBuilder::new(app, "widget", WebviewUrl::External(parsed))
        .title("Token Dashboard")
        .inner_size(280.0, 180.0)
        .min_inner_size(220.0, 120.0)
        .max_inner_size(480.0, 900.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .background_color(bg)
        .visible(true);
    // window_vibrancy requires the window to be created with
    // transparent=true on Windows; the flag can't be toggled later.
    // Always set it so the acrylic effect has a surface to compose
    // against when glass is on; when off, background_color paints solid.
    #[cfg(target_os = "windows")]
    let builder = builder.transparent(true);
    let win = builder.build().map_err(|e| {
        eprintln!("spawn_widget: build failed: {e}");
        e
    })?;
    if glass_on {
        apply_glass(&win, true);
    }
    let _ = win.set_focus();
    persist_widget_open(app, true);
    // Listen for the widget being closed so the auto-restore flag flips
    // back to false. Destroyed fires after the OS-level window is gone,
    // which covers both the in-page close button and any future tray
    // toggle.
    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            persist_widget_open(&app_handle, false);
        }
    });
    Ok(())
}

#[tauri::command]
fn open_widget(app: AppHandle, base_url: tauri::State<'_, BaseUrl>) -> Result<(), String> {
    spawn_widget(&app, &base_url.0).map_err(|e| e.to_string())
}

/// Standalone help window for the remote-machine sync setup walkthrough.
/// Renders the `#setup-help` route from the same bundle — entry.jsx
/// reads the fragment and mounts SetupHelp instead of the full shell.
fn spawn_setup_help(app: &AppHandle, base_url: &str) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("setup-help") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = format!("{base_url}/#setup-help");
    let parsed: tauri::Url = url.parse().expect("setup-help url parse");
    // Always opaque — the help text doesn't need acrylic and a transparent
    // surface let the dashboard underneath bleed through.
    let opaque_bg = tauri::utils::config::Color(0x0a, 0x0a, 0x0a, 0xff);
    let builder = WebviewWindowBuilder::new(app, "setup-help", WebviewUrl::External(parsed))
        .title("Remote machine setup")
        .inner_size(760.0, 720.0)
        .min_inner_size(420.0, 320.0)
        .decorations(false)
        .resizable(true)
        .center()
        .background_color(opaque_bg)
        .visible(true);
    let win = builder.build().map_err(|e| {
        eprintln!("spawn_setup_help: build failed: {e}");
        e
    })?;
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
fn open_setup_help(app: AppHandle, base_url: tauri::State<'_, BaseUrl>) -> Result<(), String> {
    spawn_setup_help(&app, &base_url.0).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_widget(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("widget") {
        win.close().map_err(|e| e.to_string())?;
    } else {
        // Window already gone — make sure the persisted flag agrees so
        // the next launch doesn't auto-restore a non-existent widget.
        persist_widget_open(&app, false);
    }
    Ok(())
}

#[tauri::command]
fn is_widget_open(app: AppHandle) -> bool {
    app.get_webview_window("widget").is_some()
}

#[tauri::command]
fn set_glass(app: AppHandle, on: bool) -> Result<(), String> {
    let bg = if on {
        tauri::utils::config::Color(0, 0, 0, 0)
    } else {
        tauri::utils::config::Color(0x0a, 0x0a, 0x0a, 0xff)
    };
    for label in ["main", "widget"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_background_color(Some(bg));
            apply_glass(&win, on);
        }
    }
    if let Some(state) = app.try_state::<GlassState>() {
        if let Ok(mut g) = state.0.lock() {
            *g = on;
        }
    }
    Ok(())
}

#[tauri::command]
fn show_main(app: AppHandle, base_url: tauri::State<'_, BaseUrl>) -> Result<(), String> {
    show_or_spawn_main(&app, &base_url.0);
    Ok(())
}

/// Show the main window and navigate to a hash route (e.g. `overview`,
/// `prompts`, `sessions`). The webview-side hash router listens for
/// `hashchange`, so updating `location.hash` from `eval` flips the active
/// tab. Route is allowlisted to a fixed set so untrusted strings from the
/// widget can't smuggle arbitrary JS into the eval payload.
#[tauri::command]
fn show_main_route(app: AppHandle, route: String) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "overview",
        "prompts",
        "sessions",
        "token-sink",
        "tips",
        "api",
        "settings",
    ];
    if !ALLOWED.contains(&route.as_str()) {
        return Err(format!("route not allowed: {route}"));
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // Safe to interpolate: `route` matched against ALLOWED.
        let js = format!("window.location.hash = '/{route}';");
        let _ = w.eval(&js);
    }
    Ok(())
}

struct BaseUrl(String);

/// Path to the sqlite db. Stashed in tauri state so window lifecycle
/// callbacks (widget spawn/close) can write the `widget_open` pref
/// without reaching back into AppState (which is owned by the router).
struct DbPath(PathBuf);

/// Live mirror of the `glass_enabled` preference. Updated by `set_glass`
/// so newly-spawned windows (widget) inherit the current state without
/// re-reading sqlite. The DB remains the source of truth across launches.
struct GlassState(std::sync::Mutex<bool>);

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Allowlist: only http/https URLs may be opened from the webview.
    // Anything else is rejected to prevent shell-execution surprises.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http/https urls are allowed".into());
    }
    open_browser(&url);
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "token_dashboard=info,tower_http=warn".into()),
        )
        .init();

    // Embedded server config — single process, no env passthrough.
    let db_path = std::env::var_os("TOKEN_DASHBOARD_DB")
        .map(PathBuf::from)
        .unwrap_or_else(default_db_path);
    let projects_dir = std::env::var_os("CLAUDE_PROJECTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(projects_dir_default);

    if let Err(e) = token_dashboard_core::init_db(&db_path) {
        eprintln!("init_db: {e}");
        std::process::exit(1);
    }

    // Build the Tauri context up front so `frontend_static_dir` can use
    // the resource_dir resolver (handles macOS/Linux bundle layouts).
    let context = tauri::generate_context!();

    // Point the embedded server at the on-disk frontend bundle so the
    // webview can fetch /web/styles.css, /web/dist/app.js, etc. Bundled
    // builds ship the frontend as Tauri resources; cargo-run finds it
    // at the repo root.
    if let Some(static_dir) = frontend_static_dir(&context) {
        // Safety: this ran before any thread reads env vars.
        unsafe {
            std::env::set_var("TOKEN_DASHBOARD_STATIC", &static_dir);
        }
    }

    let port = match pick_free_port().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pick port: {e}");
            std::process::exit(1);
        }
    };
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("addr");

    // Glass mode preference is read once at startup. Reads must happen
    // before db_path moves into AppState. Runtime toggles via
    // /api/preferences POST; the tray-update loop re-applies on change.
    let glass_enabled =
        token_dashboard_core::preferences::get_glass_enabled(&db_path).unwrap_or(false);
    let db_path_for_state = db_path.clone();

    let state = AppState::new(db_path, Pricing::embedded(), projects_dir);
    spawn_scan_loop(state.clone(), SCAN_INTERVAL);
    spawn_startup_oauth_sync(state.clone());
    spawn_remote_sync_loop(state.clone(), REMOTE_SYNC_INTERVAL);
    let router = build_router(state);

    let server = tokio::spawn(async move {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, router).await {
                    eprintln!("server: {e}");
                }
            }
            Err(e) => eprintln!("bind: {e}"),
        }
    });

    if let Err(e) = wait_for_ready(port).await {
        eprintln!("ready: {e}");
        server.abort();
        std::process::exit(1);
    }

    let base_url = format!("http://127.0.0.1:{port}");
    let load_url = format!("{base_url}/");

    tauri::Builder::default()
        // Single-instance must be the FIRST plugin. If another instance is
        // already running, this handler fires in the original process and
        // the new process exits — preventing the "open the app twice, get
        // two widgets and a stray error window" failure mode.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(BaseUrl(base_url.clone()))
        .manage(DbPath(db_path_for_state))
        .manage(GlassState(std::sync::Mutex::new(glass_enabled)))
        .invoke_handler(tauri::generate_handler![
            open_external,
            open_widget,
            open_setup_help,
            close_widget,
            is_widget_open,
            show_main,
            show_main_route,
            set_glass
        ])
        .setup({
            let load_url = load_url.clone();
            let base_url = base_url.clone();
            move |app: &mut tauri::App| {
                let parsed = WebviewUrl::External(load_url.parse().expect("url"));
                let bg = if glass_enabled {
                    tauri::utils::config::Color(0, 0, 0, 0)
                } else {
                    tauri::utils::config::Color(0x0a, 0x0a, 0x0a, 0xff)
                };
                let main_builder = WebviewWindowBuilder::new(app, "main", parsed)
                    .title("Token Dashboard")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(380.0, 200.0)
                    .background_color(bg)
                    .decorations(false)
                    .visible(true);
                // See widget builder note: transparent must be set at
                // creation time on Windows for acrylic to take effect.
                #[cfg(target_os = "windows")]
                let main_builder = main_builder.transparent(true);
                let win = main_builder.build()?;
                if glass_enabled {
                    apply_glass(&win, true);
                }
                let _ = win.set_focus();
                build_tray(app.handle(), &base_url)?;
                spawn_tray_updater(app.handle().clone(), base_url.clone());
                spawn_budget_alert_listener(app.handle().clone(), base_url.clone());
                // Restore the widget if it was open at last shutdown.
                // Driven entirely by the reconciler (which reads the
                // `widget_open` pref and respawns within its first tick)
                // so startup and runtime go through one path — racing
                // the reconciler with a direct spawn here used to open
                // two widget windows on launch.
                spawn_widget_reconciler(app.handle().clone(), base_url.clone());
                Ok(())
            }
        })
        .on_window_event(|window, event| {
            // Keep the main window alive in the tray on every platform.
            // Destroying it on close left the tray "Show Dashboard" entry
            // pointing at a missing webview, so the app appeared frozen
            // when the widget kept the process running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(context)
        .expect("tauri run");
}
