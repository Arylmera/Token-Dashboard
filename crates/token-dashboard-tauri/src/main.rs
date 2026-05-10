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
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use token_dashboard_cli::{app as build_router, spawn_scan_loop, AppState};
use token_dashboard_core::{default_db_path, Pricing};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const SCAN_INTERVAL: Duration = Duration::from_secs(10);

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
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
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
        .on_tray_icon_event(|tray, event| {
            // Left-click: bring the main window forward.
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                }
            ) {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
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
        use window_vibrancy::{apply_acrylic, clear_acrylic};
        if on {
            // Acrylic shows what's behind the window (other apps, not just
            // the wallpaper). Microsoft throttles it for non-system apps
            // on Win11 22H2+, so it can degrade to a flat tint on some
            // builds — accepted trade-off vs Mica's wallpaper-only blur.
            // No tint — let the acrylic blur the actual content behind
            // the window. Any non-zero alpha here becomes a permanent
            // floor that the panel-opacity slider can't see past.
            if let Err(e) = apply_acrylic(win, Some((0, 0, 0, 0))) {
                eprintln!("apply_acrylic failed: {e}");
            }
        } else {
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
/// the main shell — `entry.jsx` branches on `widget.html` and mounts the
/// Widget component instead of the full dashboard.
fn spawn_widget(app: &AppHandle, base_url: &str) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("widget") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        persist_widget_open(app, true);
        return Ok(());
    }
    // ServeDir is mounted at /web (the bare `/` route only matches the
    // root index). Hit the nest so the file resolves.
    let url = format!("{base_url}/web/widget.html");
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
fn show_main(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
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
    // Was the widget open at last shutdown? If so, re-spawn it once the
    // main window is up. Persisted via `persist_widget_open`.
    let widget_was_open =
        token_dashboard_core::preferences::get_widget_open(&db_path).unwrap_or(false);
    let db_path_for_state = db_path.clone();

    let state = AppState::new(db_path, Pricing::embedded(), projects_dir);
    spawn_scan_loop(state.clone(), SCAN_INTERVAL);
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
        .manage(BaseUrl(base_url.clone()))
        .manage(DbPath(db_path_for_state))
        .manage(GlassState(std::sync::Mutex::new(glass_enabled)))
        .invoke_handler(tauri::generate_handler![
            open_external,
            open_widget,
            show_main,
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
                let win = WebviewWindowBuilder::new(app, "main", parsed)
                    .title("Token Dashboard")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(380.0, 200.0)
                    .background_color(bg)
                    .decorations(false)
                    .visible(true)
                    .build()?;
                if glass_enabled {
                    apply_glass(&win, true);
                }
                let _ = win.set_focus();
                build_tray(app.handle(), &base_url)?;
                spawn_tray_updater(app.handle().clone(), base_url.clone());
                if widget_was_open {
                    if let Err(e) = spawn_widget(app.handle(), &base_url) {
                        eprintln!("restore widget: {e}");
                    }
                }
                Ok(())
            }
        })
        .on_window_event(|window, event| {
            // macOS keeps the app alive in the tray; other platforms quit
            // when the last window closes.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = (window, api);
                }
            }
        })
        .run(context)
        .expect("tauri run");
}
