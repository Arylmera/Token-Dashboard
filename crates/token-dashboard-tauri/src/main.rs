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

fn frontend_static_dir() -> Option<PathBuf> {
    // Walk upward from the executable looking for `frontend/index.html`,
    // matching how the python helper finds packaged resources. Falls
    // back to a repo-root sibling check for `cargo run` scenarios.
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

    // Point the embedded server at the on-disk frontend bundle so the
    // webview can fetch /web/styles.css, /web/dist/app.js, etc. Bundled
    // builds ship the frontend next to the binary; cargo-run finds it
    // at the repo root.
    if let Some(static_dir) = frontend_static_dir() {
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
                // Window — created at runtime so we can point it at the
                // dynamically-bound localhost port.
                let parsed = WebviewUrl::External(load_url.parse().expect("url"));
                let win = WebviewWindowBuilder::new(app, "main", parsed)
                    .title("Token Dashboard")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(380.0, 200.0)
                    .visible(true)
                    .build()?;
                let _ = win.set_focus();
                build_tray(app.handle(), &base_url)?;
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
        .run(tauri::generate_context!())
        .expect("tauri run");
}
