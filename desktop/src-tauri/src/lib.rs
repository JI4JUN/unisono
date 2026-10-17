//! The Unisono desktop shell.
//!
//! All product behavior lives in the Bun control server (`desktop/server.ts`);
//! this binary only owns the window. It spawns the server on startup (unless
//! one is already listening), opens a WebView at it, and kills the server
//! when the window is destroyed.

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};

const SERVER_URL: &str = "http://127.0.0.1:4737";

static SERVER: Mutex<Option<Child>> = Mutex::new(None);

/// Whether a control server is already answering on the port.
fn server_running() -> bool {
    TcpStream::connect(("127.0.0.1", 4737)).is_ok()
}

/// Spawns the Bun control server if none is running.
fn spawn_server() {
    if server_running() {
        return;
    }
    // `src-tauri` sits one level below `desktop/`, where `server.ts` lives.
    let script = format!("{}/../server.ts", env!("CARGO_MANIFEST_DIR"));
    let child = Command::new("bun").arg(&script).spawn();
    if let Ok(child) = child {
        *SERVER.lock().unwrap() = Some(child);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    spawn_server();

    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(SERVER_URL.parse().unwrap()),
            )
            .title("Unisono — One Score, All Agents")
            .inner_size(1280.0, 820.0)
            .build()?;
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(mut child) = SERVER.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Unisono desktop shell");
}
