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
use token_dashboard_cli::{app as build_router, AppState};
use token_dashboard_core::{default_db_path, Pricing};

const READY_TIMEOUT: Duration = Duration::from_secs(15);

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
    let scan_item = MenuItem::with_id(app, "scan", "Scan now", true, None::<&str>)?;
    let browser_item = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &scan_item, &browser_item, &quit_item])?;

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
            let _ = apply_acrylic(win, Some((10, 10, 10, 200)));
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

    let state = AppState::new(db_path, Pricing::embedded(), projects_dir);
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
