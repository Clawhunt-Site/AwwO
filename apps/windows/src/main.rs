#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    // Public build configuration only. Remote pages receive no native commands,
    // filesystem access, local execution bridge or operator credentials.
    let origin = tauri::Url::parse(env!("AWWO_WINDOWS_CLOUD_URL"))
        .expect("the release builder validates the cloud origin");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(origin))
                .title("AwwO")
                .inner_size(1480.0, 960.0)
                .min_inner_size(1000.0, 680.0)
                .on_navigation(move |url| {
                    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                        return false;
                    }
                    // HTTPS redirects stay in this cookie jar so access-gate
                    // identity providers can return to the application.
                    true
                })
                .on_new_window(|url, _| {
                    // Explicit external links (including LLM Gate purchases)
                    // open in the user's browser. Never launch custom protocols.
                    #[cfg(target_os = "windows")]
                    if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
                        let _ = std::process::Command::new("explorer.exe").arg(url.as_str()).spawn();
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AwwO could not start");
}
