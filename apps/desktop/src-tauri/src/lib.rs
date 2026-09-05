use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const DEFAULT_CLI_EXECUTABLE: &str = "superclaw";
const DEFAULT_WEB_DEV_URL: &str = "http://127.0.0.1:5173";
const DEFAULT_PRODUCT_NAME: &str = "ClawHunt";
const DEFAULT_RELEASE_CHANNEL: &str = "beta";
const DEFAULT_UPDATE_MODE: &str = "manual";
const UPDATE_GUIDE_RELATIVE_PATH: &str = "docs/desktop-manual-update.md";
const SMOKE_EXIT_DELAY_MS: u64 = 200;
const SMOKE_RUNTIME_BOOT_TIMEOUT_SECONDS: f64 = 30.0;
const SMOKE_RUNTIME_PROBE_TIMEOUT_SECONDS: f64 = 1.0;
const SMOKE_RUNTIME_PROBE_ATTEMPTS: usize = 5;
const SMOKE_RUNTIME_PROBE_RETRY_DELAY_MS: u64 = 300;
const DESKTOP_CLI_COMMAND_TIMEOUT_SECONDS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellInfo {
    pub product_name: String,
    pub version: String,
    pub release_channel: String,
    pub update_mode: String,
    pub workspace_root: Option<String>,
    pub web_dev_url: String,
    pub web_dist_path: Option<String>,
    pub cli_executable: String,
    pub update_guide_path: Option<String>,
    pub workspace_update_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLaunchSmokePayload {
    pub product_name: String,
    pub version: String,
    pub release_channel: String,
    pub update_mode: String,
    pub workspace_root: Option<String>,
    pub web_dist_path: Option<String>,
    pub cli_executable: String,
    pub pid: u32,
    pub launched_at_epoch_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeSmokePayload {
    pub shell: DesktopLaunchSmokePayload,
    pub start: Value,
    pub probe: Value,
    pub stop: Value,
    pub probe_after_stop: Value,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkbenchSmokePayload {
    pub shell: DesktopLaunchSmokePayload,
    pub start: Value,
    pub direct_chat: Value,
    pub goal: Value,
    pub run: Value,
    pub evidence: Value,
    pub stop: Value,
    pub probe_after_stop: Value,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopLaunchSmokeConfig {
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopRuntimeSmokeConfig {
    path: PathBuf,
    state_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopWorkbenchSmokeConfig {
    path: PathBuf,
    state_path: PathBuf,
    chat_backend: String,
    run_backend: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStartRequest {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub state_path: Option<String>,
    pub control_token: Option<String>,
    pub connect_timeout_seconds: Option<f64>,
    pub boot_timeout_seconds: Option<f64>,
    pub log_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProbeRequest {
    pub base_url: String,
    pub control_token: Option<String>,
    pub timeout_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStopRequest {
    pub pid: i64,
    pub owned: Option<bool>,
    pub wait_timeout_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopThemeRequest {
    pub theme: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenUrlRequest {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRevealPathRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRevealImageRequest {
    /// Declared MIME type; must be on the image allowlist.
    pub mime: String,
    /// Standard-base64 image bytes (the surface strips the `data:` URL prefix).
    pub data_base64: String,
    /// Optional friendly filename stem from the attachment; sanitized before use.
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopZoomRequest {
    pub factor: f64,
}

/// Diagnostics-only startup phase marker forwarded from the webview. The frontend
/// cannot write the shell log itself, so it relays each startup phase (with the
/// client-side wall-clock at the moment it fired) and the Rust side appends it to
/// `desktop-shell.log`. Putting webview phases (first paint, React mount, runtime
/// invoke) on the SAME timeline as the native shell phases is what lets us measure
/// where the cold-start seconds actually go — and the gap between `client_epoch_ms`
/// (when the webview emitted it) and the log line's own server timestamp exposes
/// any main-thread/IPC stall.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStartupMarkRequest {
    pub label: String,
    pub client_epoch_ms: Option<f64>,
}

/// A panel rectangle in CSS/logical pixels relative to the main window's content
/// area. The frontend reports its live panel geometry here; Rust overlays the
/// native browser child webview on exactly this region.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserOpenRequest {
    pub url: String,
    pub rect: BrowserRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserBoundsRequest {
    pub rect: BrowserRect,
    /// When true the webview is hidden (e.g. while the user drags the panel
    /// divider — a visible native webview would otherwise swallow the pointer
    /// stream and the resize would stall). The page stays alive; only its
    /// surface is hidden.
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBrowserNavigateRequest {
    /// One of `back` | `forward` | `reload`.
    pub action: String,
}

fn desktop_theme_from_preference(preference: &str) -> Result<Option<tauri::Theme>, String> {
    match preference {
        "system" => Ok(None),
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        value => Err(format!("unsupported desktop theme preference: {value}")),
    }
}

fn configured_workspace_root() -> Option<PathBuf> {
    // The desktop shell NEVER derives its data root implicitly — not from the
    // current working directory, and not from hardcoded developer-checkout paths.
    // Either of those was the cause of a blank-white startup window: a build whose
    // cwd (or a hardcoded candidate) sat under ~/Documents would stat that tree at
    // launch, and on macOS the first access to ~/Documents raises a system-modal
    // TCC "access your Documents folder" prompt. That prompt blocks the first
    // frame, so the window shows its default white background before the splash can
    // paint. A developer who wants the desktop app to reuse a checkout's
    // `.superclaw/` state opts in explicitly via SUPERCLAW_DESKTOP_WORKDIR;
    // otherwise the data root falls through to per-user Application Support (see
    // desktop_data_root).
    env::var_os("SUPERCLAW_DESKTOP_WORKDIR").map(PathBuf::from)
}

/// Resolve the self-contained Python backend frozen into the app bundle.
///
/// Layout: `ClawHunt.app/Contents/MacOS/<exe>` (the Tauri shell) sits next to
/// `ClawHunt.app/Contents/Resources/backend/superclaw-backend/superclaw-backend`
/// (the embedded PyInstaller backend executable). We resolve the backend
/// relative to the running executable so the app is fully relocatable and does
/// not depend on a developer workspace or `.venv`.
fn bundled_backend_executable() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    if cfg!(windows) {
        // Windows (NSIS/MSI): Tauri copies `bundle.resources` into the resource
        // directory, which on Windows is the directory of the installed
        // executable (NOT a macOS-style Contents/Resources). tauri.conf ships
        // "resources/backend/**/*", so the frozen backend lands beside the exe.
        // Try the declared layout plus a flattened fallback so we are robust to
        // the bundler's exact path prefix.
        let dir = exe.parent()?; // install dir
        let candidates = [
            dir.join("resources")
                .join("backend")
                .join("superclaw-backend")
                .join("superclaw-backend.exe"),
            dir.join("backend")
                .join("superclaw-backend")
                .join("superclaw-backend.exe"),
        ];
        return candidates.into_iter().find(|c| c.exists());
    }
    let macos_dir = exe.parent()?; // Contents/MacOS
    let contents = macos_dir.parent()?; // Contents
    let candidate = contents
        .join("Resources")
        .join("backend")
        .join("superclaw-backend")
        .join("superclaw-backend");
    candidate.exists().then_some(candidate)
}

fn default_cli_executable() -> String {
    // Explicit override (used by `tauri dev` and build verification) still wins.
    if let Ok(value) = env::var("SUPERCLAW_DESKTOP_CLI_EXECUTABLE") {
        let candidate = PathBuf::from(&value);
        let safe_name = candidate
            .file_name()
            .map(|name| name.to_string_lossy().contains("superclaw"))
            .unwrap_or(false);
        if candidate.is_absolute() && safe_name && candidate.exists() {
            return candidate.display().to_string();
        }
    }
    // Self-contained default: the backend frozen into the .app. We intentionally
    // do NOT fall back to a developer workspace `.venv` so the shipped app is
    // identical on every machine.
    if let Some(bundled) = bundled_backend_executable() {
        return bundled.display().to_string();
    }
    DEFAULT_CLI_EXECUTABLE.to_string()
}

fn workspace_update_command() -> String {
    if cfg!(windows) {
        "git pull --ff-only; .venv\\Scripts\\python.exe -m pip install -e \".[dev,tui]\"; npm install --prefix apps/web; npm install --prefix apps/desktop; npm run build --prefix apps/web; npm run tauri:build --prefix apps/desktop".to_string()
    } else {
        "git pull --ff-only && .venv/bin/python -m pip install -e \".[dev,tui]\" && npm install --prefix apps/web && npm install --prefix apps/desktop && npm run build --prefix apps/web && npm run tauri:build --prefix apps/desktop".to_string()
    }
}

pub fn desktop_shell_info_payload() -> DesktopShellInfo {
    let workspace_root = configured_workspace_root();
    DesktopShellInfo {
        product_name: DEFAULT_PRODUCT_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        release_channel: env::var("SUPERCLAW_DESKTOP_RELEASE_CHANNEL")
            .unwrap_or_else(|_| DEFAULT_RELEASE_CHANNEL.to_string()),
        update_mode: DEFAULT_UPDATE_MODE.to_string(),
        workspace_root: workspace_root
            .as_ref()
            .map(|value| value.display().to_string()),
        web_dev_url: DEFAULT_WEB_DEV_URL.to_string(),
        web_dist_path: env::var("SUPERCLAW_DESKTOP_WEB_DIST_PATH")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                workspace_root
                    .as_ref()
                    .map(|root| root.join("apps/web/dist"))
            })
            .map(|value| value.display().to_string()),
        cli_executable: default_cli_executable(),
        update_guide_path: workspace_root
            .as_ref()
            .map(|root| root.join(UPDATE_GUIDE_RELATIVE_PATH))
            .map(|value| value.display().to_string()),
        workspace_update_command: workspace_root.map(|_| workspace_update_command()),
    }
}

fn desktop_launch_smoke_config() -> Option<DesktopLaunchSmokeConfig> {
    let path = env::var_os("SUPERCLAW_DESKTOP_SMOKE_FILE")?;
    if path.is_empty() {
        return None;
    }
    Some(DesktopLaunchSmokeConfig {
        path: PathBuf::from(path),
    })
}

fn desktop_runtime_smoke_config() -> Option<DesktopRuntimeSmokeConfig> {
    let path = env::var_os("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_FILE")?;
    if path.is_empty() {
        return None;
    }
    let state_path = env::var_os("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_STATE_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("superclaw-desktop-runtime-smoke/state.db"));
    Some(DesktopRuntimeSmokeConfig {
        path: PathBuf::from(path),
        state_path,
    })
}

fn desktop_workbench_smoke_config() -> Option<DesktopWorkbenchSmokeConfig> {
    let path = env::var_os("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_FILE")?;
    if path.is_empty() {
        return None;
    }
    let state_path = env::var_os("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_STATE_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("superclaw-desktop-workbench-smoke/state.db"));
    let chat_backend = env::var("SUPERCLAW_DESKTOP_WORKBENCH_CHAT_BACKEND")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "codex".to_string());
    let run_backend = env::var("SUPERCLAW_DESKTOP_WORKBENCH_RUN_BACKEND")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local".to_string());
    Some(DesktopWorkbenchSmokeConfig {
        path: PathBuf::from(path),
        state_path,
        chat_backend,
        run_backend,
    })
}

fn build_desktop_launch_smoke_payload(info: &DesktopShellInfo) -> DesktopLaunchSmokePayload {
    DesktopLaunchSmokePayload {
        product_name: info.product_name.clone(),
        version: info.version.clone(),
        release_channel: info.release_channel.clone(),
        update_mode: info.update_mode.clone(),
        workspace_root: info.workspace_root.clone(),
        web_dist_path: info.web_dist_path.clone(),
        cli_executable: info.cli_executable.clone(),
        pid: std::process::id(),
        launched_at_epoch_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_millis(),
    }
}

fn write_desktop_launch_smoke_payload(
    path: &Path,
    payload: &DesktopLaunchSmokePayload,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create desktop smoke directory {}: {err}",
                parent.display()
            )
        })?;
    }
    let body = serde_json::to_vec_pretty(payload)
        .map_err(|err| format!("failed to serialize desktop smoke payload: {err}"))?;
    fs::write(path, body).map_err(|err| {
        format!(
            "failed to write desktop smoke payload {}: {err}",
            path.display()
        )
    })
}

fn write_json_payload<T: Serialize>(path: &Path, payload: &T, label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create {label} directory {}: {err}",
                parent.display()
            )
        })?;
    }
    let body = serde_json::to_vec_pretty(payload)
        .map_err(|err| format!("failed to serialize {label} payload: {err}"))?;
    fs::write(path, body)
        .map_err(|err| format!("failed to write {label} payload {}: {err}", path.display()))
}

fn append_error(error: &mut Option<String>, detail: String) {
    match error {
        Some(existing) => {
            if !existing.contains(&detail) {
                existing.push_str("; ");
                existing.push_str(&detail);
            }
        }
        None => *error = Some(detail),
    }
}

fn http_json_request(
    method: &str,
    url: &str,
    control_token: Option<&str>,
    payload: Option<Value>,
    timeout_seconds: f64,
) -> Result<Value, String> {
    let timeout = Duration::from_secs_f64(timeout_seconds.max(0.1));
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build();
    let mut request = match method {
        "GET" => agent.get(url),
        "POST" => agent.post(url),
        _ => return Err(format!("unsupported desktop smoke HTTP method: {method}")),
    };
    if let Some(token) = control_token {
        request = request.set("X-SuperClaw-Token", token);
    }
    let response = match payload {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match response {
        Ok(response) => response
            .into_json::<Value>()
            .map_err(|err| format!("failed to decode {method} {url} JSON: {err}")),
        Err(ureq::Error::Status(code, response)) => {
            let detail = response
                .into_string()
                .unwrap_or_else(|_| "<unreadable response body>".to_string());
            Err(format!(
                "{method} {url} returned HTTP {code}: {}",
                detail.trim()
            ))
        }
        Err(ureq::Error::Transport(err)) => Err(format!("{method} {url} transport error: {err}")),
    }
}

fn run_launch_smoke(config: DesktopLaunchSmokeConfig) -> Result<(), String> {
    let payload = build_desktop_launch_smoke_payload(&desktop_shell_info_payload());
    write_desktop_launch_smoke_payload(&config.path, &payload)
}

fn maybe_schedule_launch_smoke(app: &tauri::App) -> Result<bool, String> {
    let Some(config) = desktop_launch_smoke_config() else {
        return Ok(false);
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    run_launch_smoke(config)?;
    let app_handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(SMOKE_EXIT_DELAY_MS));
        app_handle.exit(0);
    });
    Ok(true)
}

fn run_workbench_smoke(config: DesktopWorkbenchSmokeConfig) -> Result<bool, String> {
    let shell = build_desktop_launch_smoke_payload(&desktop_shell_info_payload());
    let workspace_root = shell
        .workspace_root
        .clone()
        .ok_or("desktop workbench smoke missing workspace_root")?;
    let artifact_dir = config
        .state_path
        .parent()
        .map(|parent| parent.join("artifacts"))
        .unwrap_or_else(|| env::temp_dir().join("superclaw-desktop-workbench-artifacts"));
    let mut error = None;
    let mut start = Value::Null;
    let mut direct_chat = Value::Null;
    let mut goal = Value::Null;
    let mut run = Value::Null;
    let mut evidence = Value::Null;
    let mut stop = Value::Null;
    let mut probe_after_stop = Value::Null;
    let mut runtime_base_url = None;
    let mut runtime_control_token = None;
    let mut runtime_pid = None;
    let mut runtime_owned = None;
    match (|| -> Result<(), String> {
        start = invoke_cli_json(&build_desktop_start_command(&DesktopStartRequest {
            state_path: Some(config.state_path.display().to_string()),
            // Packaged workbench smoke drives a FROZEN cold start, which pays the
            // one-time macOS Gatekeeper dylib assessment (~10-20s); 10s undershot
            // it and flaked the smoke. Align with the runtime smoke budget.
            boot_timeout_seconds: Some(SMOKE_RUNTIME_BOOT_TIMEOUT_SECONDS),
            connect_timeout_seconds: Some(0.5),
            log_level: Some("warning".to_string()),
            ..DesktopStartRequest::default()
        }))?;
        let handle = start
            .get("handle")
            .and_then(Value::as_object)
            .ok_or("desktop workbench smoke missing handle")?;
        runtime_base_url = Some(
            handle
                .get("base_url")
                .and_then(Value::as_str)
                .ok_or("desktop workbench smoke missing base_url")?
                .to_string(),
        );
        runtime_control_token = handle
            .get("control_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        runtime_pid = Some(
            handle
                .get("pid")
                .and_then(Value::as_i64)
                .ok_or("desktop workbench smoke missing pid")?,
        );
        runtime_owned = Some(
            handle
                .get("owned")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        let base_url = runtime_base_url
            .as_deref()
            .ok_or("desktop workbench smoke missing runtime URL")?;
        let control_token = runtime_control_token.as_deref();
        http_json_request(
            "POST",
            &format!("{base_url}/api/workspaces"),
            control_token,
            Some(serde_json::json!({
                "name": "Desktop smoke workspace",
                "attach_repo": workspace_root.clone(),
                "trust_confirmed": true,
            })),
            10.0,
        )?;
        direct_chat = http_json_request(
            "POST",
            &format!("{base_url}/api/chat/direct"),
            control_token,
            Some(serde_json::json!({
                "message": "Reply with a short confirmation that the packaged desktop workbench smoke path is live.",
                "backend_policy": config.chat_backend.clone(),
                "repo_path": workspace_root.clone(),
                "budget_seconds": 45,
            })),
            60.0,
        )?;
        goal = http_json_request(
            "POST",
            &format!("{base_url}/api/goals"),
            control_token,
            Some(serde_json::json!({
                "title": "Desktop workbench smoke",
                "description": "Prove the packaged desktop shell can run direct chat and a delivery dry-run.",
            })),
            10.0,
        )?;
        let goal_id = goal
            .get("goal_id")
            .and_then(Value::as_str)
            .ok_or("desktop workbench smoke missing goal_id")?;
        run = http_json_request(
            "POST",
            &format!("{base_url}/api/runs"),
            control_token,
            Some(serde_json::json!({
                "goal_id": goal_id,
                "dry_run": true,
                "backend_policy": config.run_backend.clone(),
                "repo_path": workspace_root.clone(),
                "artifact_dir": artifact_dir.display().to_string(),
                "budget_seconds": 20,
            })),
            30.0,
        )?;
        let run_id = run
            .get("run_id")
            .and_then(Value::as_str)
            .ok_or("desktop workbench smoke missing run_id")?;
        evidence = http_json_request(
            "GET",
            &format!("{base_url}/api/runs/{run_id}/evidence"),
            control_token,
            None,
            10.0,
        )?;
        Ok(())
    })() {
        Ok(()) => {}
        Err(err) => append_error(&mut error, err),
    }
    if let (Some(base_url), Some(pid)) = (runtime_base_url.clone(), runtime_pid) {
        match invoke_cli_json(&build_desktop_stop_command(&DesktopStopRequest {
            pid,
            owned: runtime_owned,
            wait_timeout_seconds: Some(2.0),
        })) {
            Ok(value) => {
                stop = value;
            }
            Err(err) => append_error(
                &mut error,
                format!("desktop workbench smoke stop failed: {err}"),
            ),
        }
        match invoke_cli_json(&build_desktop_probe_command(&DesktopProbeRequest {
            base_url,
            control_token: runtime_control_token.clone(),
            timeout_seconds: Some(0.2),
        })) {
            Ok(value) => {
                probe_after_stop = value;
            }
            Err(err) => append_error(
                &mut error,
                format!("desktop workbench smoke probe-after-stop failed: {err}"),
            ),
        }
    }
    let success = error.is_none()
        && direct_chat.get("status").and_then(Value::as_str) == Some("completed")
        && direct_chat
            .get("response")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        && goal.get("goal_id").and_then(Value::as_str).is_some()
        && run.get("status").and_then(Value::as_str) == Some("completed")
        && evidence.get("chain_verdict").and_then(Value::as_str) == Some("CHAIN_PARTIAL")
        && stop.get("ok").and_then(Value::as_bool) == Some(true)
        && stop.get("stopped").and_then(Value::as_bool) == Some(true)
        && probe_after_stop.get("ok").and_then(Value::as_bool) == Some(false);
    if !success && error.is_none() {
        error = Some("desktop workbench smoke did not satisfy the expected direct-chat/dry-run/evidence contract".to_string());
    }
    let payload = DesktopWorkbenchSmokePayload {
        shell,
        start,
        direct_chat,
        goal,
        run,
        evidence,
        stop,
        probe_after_stop,
        success,
        error,
    };
    write_json_payload(&config.path, &payload, "desktop workbench smoke")?;
    Ok(payload.success)
}

fn maybe_schedule_workbench_smoke(app: &tauri::App) -> Result<bool, String> {
    let Some(config) = desktop_workbench_smoke_config() else {
        return Ok(false);
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let success = run_workbench_smoke(config)?;
    let app_handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(SMOKE_EXIT_DELAY_MS));
        app_handle.exit(if success { 0 } else { 1 });
    });
    Ok(true)
}

fn run_runtime_smoke(config: DesktopRuntimeSmokeConfig) -> Result<bool, String> {
    let shell = build_desktop_launch_smoke_payload(&desktop_shell_info_payload());
    let mut success = false;
    let mut error = None;
    let mut start = Value::Null;
    let mut probe = Value::Null;
    let mut stop = Value::Null;
    let mut probe_after_stop = Value::Null;
    match (|| -> Result<(), String> {
        start = invoke_cli_json(&build_desktop_start_command(&DesktopStartRequest {
            state_path: Some(config.state_path.display().to_string()),
            boot_timeout_seconds: Some(SMOKE_RUNTIME_BOOT_TIMEOUT_SECONDS),
            connect_timeout_seconds: Some(0.5),
            log_level: Some("warning".to_string()),
            ..DesktopStartRequest::default()
        }))?;
        let handle = start
            .get("handle")
            .and_then(Value::as_object)
            .ok_or("desktop runtime smoke missing handle")?;
        let base_url = handle
            .get("base_url")
            .and_then(Value::as_str)
            .ok_or("desktop runtime smoke missing base_url")?;
        let control_token = handle
            .get("control_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        let pid = handle
            .get("pid")
            .and_then(Value::as_i64)
            .ok_or("desktop runtime smoke missing pid")?;
        let owned = handle
            .get("owned")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        probe = probe_runtime_until_ready(base_url, control_token.clone())?;
        stop = invoke_cli_json(&build_desktop_stop_command(&DesktopStopRequest {
            pid,
            owned: Some(owned),
            wait_timeout_seconds: Some(2.0),
        }))?;
        probe_after_stop = invoke_cli_json(&build_desktop_probe_command(&DesktopProbeRequest {
            base_url: base_url.to_string(),
            control_token,
            timeout_seconds: Some(0.2),
        }))?;
        success = probe.get("ok").and_then(Value::as_bool) == Some(true)
            && stop.get("ok").and_then(Value::as_bool) == Some(true)
            && stop.get("stopped").and_then(Value::as_bool) == Some(true)
            && probe_after_stop.get("ok").and_then(Value::as_bool) == Some(false);
        if !success {
            return Err(
                "desktop runtime smoke did not reach the expected start/probe/stop contract"
                    .to_string(),
            );
        }
        Ok(())
    })() {
        Ok(()) => {}
        Err(err) => {
            error = Some(err);
        }
    }
    let payload = DesktopRuntimeSmokePayload {
        shell,
        start,
        probe,
        stop,
        probe_after_stop,
        success,
        error,
    };
    write_json_payload(&config.path, &payload, "desktop runtime smoke")?;
    Ok(payload.success)
}

fn maybe_schedule_runtime_smoke(app: &tauri::App) -> Result<bool, String> {
    let Some(config) = desktop_runtime_smoke_config() else {
        return Ok(false);
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let success = run_runtime_smoke(config)?;
    let app_handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(SMOKE_EXIT_DELAY_MS));
        app_handle.exit(if success { 0 } else { 1 });
    });
    Ok(true)
}

fn probe_runtime_until_ready(
    base_url: &str,
    control_token: Option<String>,
) -> Result<Value, String> {
    let mut last_probe = Value::Null;
    for attempt in 0..SMOKE_RUNTIME_PROBE_ATTEMPTS {
        last_probe = invoke_cli_json(&build_desktop_probe_command(&DesktopProbeRequest {
            base_url: base_url.to_string(),
            control_token: control_token.clone(),
            timeout_seconds: Some(SMOKE_RUNTIME_PROBE_TIMEOUT_SECONDS),
        }))?;
        if last_probe.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(last_probe);
        }
        if attempt + 1 < SMOKE_RUNTIME_PROBE_ATTEMPTS {
            thread::sleep(Duration::from_millis(SMOKE_RUNTIME_PROBE_RETRY_DELAY_MS));
        }
    }
    Ok(last_probe)
}

fn format_float(value: f64) -> String {
    let mut rendered = value.to_string();
    if !rendered.contains('.') && !rendered.contains('e') && !rendered.contains('E') {
        rendered.push_str(".0");
        return rendered;
    }
    if rendered.contains('e') || rendered.contains('E') {
        return rendered;
    }
    while rendered.ends_with('0') {
        rendered.pop();
    }
    if rendered.ends_with('.') {
        rendered.push('0');
    }
    rendered
}

fn normalize_external_url(url: &str) -> Result<&str, String> {
    if url.chars().any(char::is_control) {
        return Err("desktop external URL must not contain control characters".to_string());
    }
    let url = url.trim();
    if url.is_empty() {
        return Err("desktop external URL must not be empty".to_string());
    }
    if url.chars().any(char::is_whitespace) || url.contains('"') || url.contains('\'') {
        return Err("desktop external URL must not contain raw whitespace or quotes".to_string());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("desktop external URL must use http or https".to_string());
    }
    Ok(url)
}

fn open_external_url(request: &DesktopOpenUrlRequest) -> Result<Value, String> {
    let url = normalize_external_url(&request.url)?;
    open_external_url_with_command(url)
}

fn open_external_url_with_command(url: &str) -> Result<Value, String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    let output = command
        .output()
        .map_err(|err| format!("failed to open external URL: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no output".to_string()
        };
        return Err(format!(
            "external URL opener failed with exit code {}: {detail}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(serde_json::json!({ "ok": true, "url": url }))
}

/// Reveal a workspace folder OR a file in the OS file manager (Finder/Explorer).
/// The path is a workspace `repo_path` from the kernel projection or a local image
/// attachment path; we still fail-closed if it is empty or does not exist rather
/// than handing an arbitrary string to the shell. macOS/Windows select (highlight)
/// the item; Linux opens it (no portable reveal-and-select).
fn reveal_path(request: &DesktopRevealPathRequest) -> Result<Value, String> {
    let raw = request.path.trim();
    if raw.is_empty() {
        return Err("reveal path must not be empty".to_string());
    }
    if !Path::new(raw).exists() {
        return Err(format!("reveal path does not exist: {raw}"));
    }
    os_reveal(raw)
}

/// Spawn the OS "reveal / select in the file manager" command for a path the
/// caller has ALREADY validated as existing. macOS `open -R` selects the item in
/// Finder (works for files and folders); Windows selects it in Explorer; Linux
/// has no portable reveal-and-select, so it just opens the path. This only spawns
/// — callers own the fail-closed existence check.
fn os_reveal(raw: &str) -> Result<Value, String> {
    let mut command = if cfg!(target_os = "macos") {
        // `open -R` selects the item in Finder (file OR folder) and never launches it.
        let mut command = Command::new("open");
        command.args(["-R", raw]);
        command
    } else if cfg!(target_os = "windows") {
        // explorer `/select,` highlights the item in its containing folder.
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{raw}"));
        command
    } else {
        // Linux has no portable reveal-and-select. CRITICAL: never hand a FILE to
        // `xdg-open` — it would launch the file's default handler (opening or even
        // executing it), not a file manager. Always open the *containing directory*
        // so a file path can never become arbitrary local execution. Fail-closed.
        let path = Path::new(raw);
        let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
        let mut command = Command::new("xdg-open");
        command.arg(dir);
        command
    };
    let output = command
        .output()
        .map_err(|err| format!("failed to reveal path: {err}"))?;
    // explorer.exe returns a non-zero exit code even on success, so only treat a
    // spawn failure (above) as fatal there; elsewhere honor the exit status.
    if !output.status.success() && !cfg!(target_os = "windows") {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "reveal failed with exit code {}: {}",
            output.status.code().unwrap_or(-1),
            if stderr.is_empty() { "no output".to_string() } else { stderr },
        ));
    }
    Ok(serde_json::json!({ "ok": true, "path": raw }))
}

/// Upper bound on a revealed image's decoded size. This is a scratch file we write
/// solely so Finder has a real path to select; the cap only guards against a
/// hostile/absurd payload bloating the reveal folder.
const MAX_REVEAL_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Allowlisted image MIME types and the file extension we save each as. Anything
/// off this list is rejected — the surface must never smuggle an arbitrary type.
fn image_ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Magic-byte sniff: the declared MIME must match the actual leading bytes, so a
/// hostile surface cannot smuggle a non-image (or a mismatched type) past the
/// extension we pick. Mirrors the kernel's "magic-byte is the sole authority" rule.
fn image_magic_ok(mime: &str, bytes: &[u8]) -> bool {
    match mime.trim() {
        "image/png" => bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    }
}

/// Decode + validate an image payload fail-closed: MIME must be allowlisted, the
/// base64 must decode, the result must be non-empty, within `max_bytes`, and its
/// magic bytes must match the declared MIME. Returns the raw bytes + chosen file
/// extension. Pure (no I/O) so it is unit-testable without a Finder/shell.
fn decode_and_validate_image(
    mime: &str,
    data_base64: &str,
    max_bytes: usize,
) -> Result<(Vec<u8>, &'static str), String> {
    let ext = image_ext_for_mime(mime).ok_or_else(|| format!("unsupported image type: {mime}"))?;
    let encoded = data_base64.trim();
    // Fail-closed on memory BEFORE decoding: base64 expands 3 bytes -> 4 chars, so an
    // oversized payload is rejected by its (cheap) encoded length rather than after
    // allocating the decoded Vec. Without this a hostile/absurd string could OOM the
    // shell just to be rejected a line later.
    if encoded.len() / 4 * 3 > max_bytes {
        return Err(format!("image too large: ~{} encoded bytes", encoded.len()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|err| format!("invalid image data: {err}"))?;
    if bytes.is_empty() {
        return Err("image data is empty".to_string());
    }
    // Exact check after decode (defense in depth; the preflight over-estimates).
    if bytes.len() > max_bytes {
        return Err(format!("image too large: {} bytes", bytes.len()));
    }
    if !image_magic_ok(mime, &bytes) {
        return Err("image bytes do not match declared type".to_string());
    }
    Ok((bytes, ext))
}

/// Reduce an attachment name to a safe filename stem: drop directory components
/// and any extension, keep ASCII alphanumerics / dash / underscore, collapse the
/// rest to '-', bound the length, and fall back to "image" when nothing usable
/// remains. Prevents path traversal or odd shell-visible names in the reveal folder.
fn sanitize_image_stem(name: Option<&str>) -> String {
    let raw = name.unwrap_or("").trim();
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
    let mut out = String::new();
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed
    }
}

/// Short, content-derived filename suffix so two different images with the same
/// stem do not overwrite each other, while revealing the SAME image twice reuses
/// one file (idempotent). Not cryptographic — just a dedup key for the scratch dir.
/// Inline FNV-1a rather than `DefaultHasher` because the latter's output is NOT
/// stable across Rust versions, so a toolchain bump would re-tag identical images
/// and leave orphans; FNV-1a is fixed forever.
fn image_content_tag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV offset basis
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    format!("{hash:016x}")
}

/// Materialize an in-memory image (forwarded as base64 from a data URL on the
/// surface) into the desktop data root's `saved-images/` folder, then reveal it in
/// Finder/Explorer. Pasted/uploaded images have no source file on disk; this gives
/// "Reveal in Finder" a real, app-owned path to select. Fail-closed at every step.
/// Validate + write the image bytes into `saved-images/` and return the path.
/// Split out from `reveal_image` (which then spawns the file manager) so the write
/// path — the part unique to this feature — is unit-testable WITHOUT popping Finder.
fn materialize_reveal_image(request: &DesktopRevealImageRequest) -> Result<PathBuf, String> {
    let (bytes, ext) =
        decode_and_validate_image(&request.mime, &request.data_base64, MAX_REVEAL_IMAGE_BYTES)?;
    let root = desktop_data_root().ok_or_else(|| "no desktop data root available".to_string())?;
    let dir = root.join("saved-images");
    fs::create_dir_all(&dir).map_err(|err| format!("failed to create saved-images dir: {err}"))?;
    let stem = sanitize_image_stem(request.name.as_deref());
    let tag = image_content_tag(&bytes);
    let path = dir.join(format!("{stem}-{tag}.{ext}"));
    fs::write(&path, &bytes).map_err(|err| format!("failed to write image: {err}"))?;
    Ok(path)
}

fn reveal_image(request: &DesktopRevealImageRequest) -> Result<Value, String> {
    let path = materialize_reveal_image(request)?;
    os_reveal(&path.to_string_lossy())
}

/// Label of the single native browser child webview overlaid on the reference
/// panel. There is at most one at a time; reopening reuses it.
const REF_BROWSER_LABEL: &str = "superclaw-ref-browser";

/// Whether a URL may load in the native browser child webview. This is the
/// *security boundary*, enforced on EVERY navigation (not just the initial open):
/// http/https only, and never to a loopback/unspecified host or the app's own
/// (`tauri://`/`*.localhost`) origin. The threat it closes is the IPC-escalation
/// escape: reaching the app origin would flip the webview to `is_local` and
/// unlock the IPC bridge (Tauri only ACL-denies commands from *remote* origins),
/// so a remote page redirecting/clicking toward `tauri://localhost` or
/// `127.0.0.1` must be blocked here. NOTE: private/LAN hosts (10/8, 192.168/16,
/// link-local, fc00::/7, fe80::/10) are intentionally NOT blocked — this is a
/// real browser, not the SSRF-guarded reader, so browsing a router/NAS/local dev
/// box is allowed; none of those are ever the app origin, so IPC stays closed.
fn browser_url_is_navigable(url: &tauri::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    // IP literals (IPv6 arrives bracketed): refuse loopback / unspecified only.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(v4) = bare.parse::<std::net::Ipv4Addr>() {
        return !(v4.is_loopback() || v4.is_unspecified());
    }
    if let Ok(v6) = bare.parse::<std::net::Ipv6Addr>() {
        if v6.is_loopback() || v6.is_unspecified() {
            return false;
        }
        // IPv4-mapped (`::ffff:127.0.0.1`) / -compatible (`::127.0.0.1`) addresses
        // route to the v4 stack, but `Ipv6Addr::is_loopback()` matches only `::1`.
        // Collapse to the embedded v4 and re-check, or loopback slips through.
        if let Some(v4) = v6.to_ipv4() {
            return !(v4.is_loopback() || v4.is_unspecified());
        }
        return true;
    }
    true
}

/// Validate a browser target (clean http/https via `normalize_external_url`, then
/// the navigability boundary above) and parse it into a navigable URL.
fn parse_browser_url(raw: &str) -> Result<tauri::Url, String> {
    let normalized = normalize_external_url(raw)?;
    let url = normalized
        .parse::<tauri::Url>()
        .map_err(|err| format!("invalid browser URL: {err}"))?;
    if !browser_url_is_navigable(&url) {
        return Err(
            "browser URL must be http/https to a non-loopback, non-local-origin host".to_string(),
        );
    }
    Ok(url)
}

/// Convert a frontend-reported logical rectangle into a Tauri logical `Rect`,
/// rejecting non-finite values and clamping negative extents to zero so a bogus
/// layout snapshot can never hand the platform a NaN/negative geometry.
fn browser_rect_to_tauri(rect: &BrowserRect) -> Result<tauri::Rect, String> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
    {
        return Err("browser rect components must be finite".to_string());
    }
    Ok(tauri::Rect {
        position: tauri::LogicalPosition::new(rect.x, rect.y).into(),
        size: tauri::LogicalSize::new(rect.width.max(0.0), rect.height.max(0.0)).into(),
    })
}

/// Push a browser state update into the *main* (React) webview by evaluating a
/// `CustomEvent` dispatch. We deliberately bridge via `eval` rather than the
/// Tauri event API: the web client ships no `@tauri-apps/api`, so it cannot call
/// the ACL-gated `core:event` `listen` command — a plain DOM CustomEvent needs
/// no capability grant. The JSON payload is a valid JS object literal; the URL
/// inside is JSON-escaped, so it cannot break out of the literal.
fn push_browser_event(app: &tauri::AppHandle, payload: &Value) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(json) = serde_json::to_string(payload) else {
        return;
    };
    let script =
        format!("window.dispatchEvent(new CustomEvent('superclaw:ref-browser',{{detail:{json}}}))");
    let _ = main.eval(script);
}

fn cli_command_base(cli_executable: Option<&str>) -> CommandSpec {
    CommandSpec {
        executable: cli_executable
            .unwrap_or(&default_cli_executable())
            .to_string(),
        args: vec!["desktop".to_string()],
    }
}

fn build_desktop_start_command_for(
    request: &DesktopStartRequest,
    cli_executable: Option<&str>,
) -> CommandSpec {
    let mut spec = cli_command_base(cli_executable);
    spec.args.push("start".to_string());
    if let Some(host) = &request.host {
        spec.args.extend(["--host".to_string(), host.clone()]);
    }
    if let Some(port) = request.port {
        spec.args.extend(["--port".to_string(), port.to_string()]);
    }
    if let Some(state_path) = &request.state_path {
        spec.args
            .extend(["--state-path".to_string(), state_path.clone()]);
    }
    if let Some(control_token) = &request.control_token {
        spec.args
            .extend(["--control-token".to_string(), control_token.clone()]);
    }
    if let Some(connect_timeout_seconds) = request.connect_timeout_seconds {
        spec.args.extend([
            "--connect-timeout".to_string(),
            format_float(connect_timeout_seconds),
        ]);
    }
    if let Some(boot_timeout_seconds) = request.boot_timeout_seconds {
        spec.args.extend([
            "--boot-timeout".to_string(),
            format_float(boot_timeout_seconds),
        ]);
    }
    if let Some(log_level) = &request.log_level {
        spec.args
            .extend(["--log-level".to_string(), log_level.clone()]);
    }
    spec
}

pub fn build_desktop_start_command(request: &DesktopStartRequest) -> CommandSpec {
    build_desktop_start_command_for(request, None)
}

fn build_desktop_probe_command_for(
    request: &DesktopProbeRequest,
    cli_executable: Option<&str>,
) -> CommandSpec {
    let mut spec = cli_command_base(cli_executable);
    spec.args.extend([
        "probe".to_string(),
        "--base-url".to_string(),
        request.base_url.clone(),
    ]);
    if let Some(control_token) = &request.control_token {
        spec.args
            .extend(["--control-token".to_string(), control_token.clone()]);
    }
    if let Some(timeout_seconds) = request.timeout_seconds {
        spec.args
            .extend(["--timeout".to_string(), format_float(timeout_seconds)]);
    }
    spec
}

pub fn build_desktop_probe_command(request: &DesktopProbeRequest) -> CommandSpec {
    build_desktop_probe_command_for(request, None)
}

fn build_desktop_stop_command_for(
    request: &DesktopStopRequest,
    cli_executable: Option<&str>,
) -> CommandSpec {
    let mut spec = cli_command_base(cli_executable);
    spec.args.extend([
        "stop".to_string(),
        "--pid".to_string(),
        request.pid.to_string(),
    ]);
    if matches!(request.owned, Some(false)) {
        spec.args.push("--no-owned".to_string());
    }
    if let Some(wait_timeout_seconds) = request.wait_timeout_seconds {
        spec.args.extend([
            "--wait-timeout".to_string(),
            format_float(wait_timeout_seconds),
        ]);
    }
    spec
}

pub fn build_desktop_stop_command(request: &DesktopStopRequest) -> CommandSpec {
    build_desktop_stop_command_for(request, None)
}

/// Stable, writable working directory for the spawned backend.
///
/// In a developer checkout this is the workspace root (so existing
/// `.superclaw/` state, plugins and artifacts keep working). On a machine that
/// only has the shipped app, there is no workspace, so we fall back to a
/// per-user Application Support directory — otherwise a Finder launch inherits
/// cwd `/` and relative paths like `.superclaw/state.db` hit a read-only volume.
fn desktop_data_root() -> Option<PathBuf> {
    if let Some(root) = configured_workspace_root() {
        return Some(root);
    }
    // Shipped app with no developer workspace: fall back to a per-user app-data
    // dir so the shell can write logs and the sidecar gets a stable, writable
    // workdir (a Finder/Explorer launch otherwise inherits cwd `/` or `C:\`).
    // Windows has no `$HOME` and no `~/Library/Application Support` — without a
    // Windows branch this returned None, so desktop-shell.log silently never
    // wrote and the data root was unset.
    #[cfg(target_os = "windows")]
    let candidate = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(|base| PathBuf::from(base).join("ClawHunt"));
    // The macOS/Linux data root stays "SuperClaw" across the ClawHunt rebrand: it is
    // the packaged app's working dir (resolves .superclaw/state.db, desktop-shell.log,
    // the watchdog migration stamp) and existing installs + session-lookup tooling scan
    // this exact path. Renaming it would orphan prior state — it is NOT a user-facing
    // brand string.
    #[cfg(not(target_os = "windows"))]
    let candidate = env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("SuperClaw")
    });
    if let Some(dir) = candidate {
        if fs::create_dir_all(&dir).is_ok() {
            return Some(dir);
        }
    }
    None
}

fn read_child_pipe<R: Read + Send + 'static>(mut pipe: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        buffer
    })
}

fn join_child_output(handle: Option<thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

fn invoke_cli_json_with_timeout(spec: &CommandSpec, timeout: Duration) -> Result<Value, String> {
    let mut command = Command::new(&spec.executable);
    command.args(&spec.args);
    if let Some(root) = desktop_data_root() {
        command.current_dir(root);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // The frozen backend (superclaw-backend.exe) is a console-subsystem binary; on
    // Windows, spawning it normally flashes an empty console window. Its stdio is fully
    // piped above, so suppress the console with CREATE_NO_WINDOW. Covers every CLI
    // invocation routed through here (incl. `desktop start` runtime launch + the
    // watchdog-migration stop marker). No-op / not compiled off Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to launch {}: {err}", spec.executable))?;
    let stdout_reader = child.stdout.take().map(read_child_pipe);
    let stderr_reader = child.stderr.take().map(read_child_pipe);
    let started_at = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|err| format!("failed to wait for {}: {err}", spec.executable))?
        {
            Some(status) => break status,
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let stdout = String::from_utf8_lossy(&join_child_output(stdout_reader))
                    .trim()
                    .to_string();
                let stderr = String::from_utf8_lossy(&join_child_output(stderr_reader))
                    .trim()
                    .to_string();
                let detail = if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    "no output".to_string()
                };
                return Err(format!(
                    "{} {:?} timed out after {:.1}s: {}",
                    spec.executable,
                    spec.args,
                    timeout.as_secs_f64(),
                    detail
                ));
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    };
    let stdout = join_child_output(stdout_reader);
    let stderr = join_child_output(stderr_reader);
    if !status.success() {
        let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no output".to_string()
        };
        return Err(format!(
            "{} {:?} failed with exit code {}: {}",
            spec.executable,
            spec.args,
            status.code().unwrap_or(-1),
            detail
        ));
    }
    serde_json::from_slice(&stdout)
        .map_err(|err| format!("failed to decode desktop CLI JSON: {err}"))
}

pub fn invoke_cli_json(spec: &CommandSpec) -> Result<Value, String> {
    invoke_cli_json_with_timeout(
        spec,
        Duration::from_secs(DESKTOP_CLI_COMMAND_TIMEOUT_SECONDS),
    )
}

/// Tracks whether the app is genuinely quitting (vs a window-close that hides).
///
/// We no longer track/kill the sidecar pid from the UI side: a sidecar the App
/// spawns is started with `--watch-ui-pid <our pid>`, so it runs its own watchdog
/// and self-terminates the moment this process exits — robust against a swallowed
/// Cmd+Q, a SIGKILL/force-quit, a crash, and shutdown alike, and it never touches
/// a CLI-started sidecar (which carries no watch pid). That makes UI-side exit
/// cleanup and the startup sweep unnecessary (and the sweep was unsafe — it could
/// reap a user's CLI sidecar and blocked the IPC thread).
#[derive(Default)]
struct SidecarOwnership {
    quitting: std::sync::atomic::AtomicBool,
    /// Re-entrancy guard for desktop_runtime_start. The command is async (so the
    /// backend cold start no longer freezes the UI), which means a hard reload
    /// (Cmd+R) or a remount during the multi-second boot can fire a SECOND start
    /// while the first is still in flight — the frontend's single-flight ref is
    /// reset by a reload and cannot guard across it. We CAS this flag so only one
    /// start runs at a time, preventing a duplicate sidecar spawn / port + state
    /// race during the boot window.
    starting: std::sync::atomic::AtomicBool,
}

mod commands {
    use super::*;

    #[tauri::command]
    pub fn desktop_shell_info() -> DesktopShellInfo {
        desktop_shell_info_payload()
    }

    /// Diagnostics-only: record a webview-side startup phase marker into the shell
    /// log so frontend phases land on the same timeline as the native ones. Pure
    /// instrumentation — it only appends one sanitized log line and never alters
    /// startup behaviour.
    #[tauri::command]
    pub fn desktop_record_startup_mark(request: DesktopStartupMarkRequest) -> Result<Value, String> {
        use std::sync::atomic::Ordering;
        let label = sanitize_startup_mark_label(&request.label);
        // Fail-closed: only known startup phases are ever written, and a process-wide
        // budget caps the total. An unknown label or an exhausted budget is dropped
        // silently (ok=true, recorded=false) so the renderer cannot grow the log
        // unbounded or forge arbitrary phase strings.
        if !is_known_startup_mark(&label) {
            return Ok(serde_json::json!({ "ok": true, "recorded": false, "reason": "unknown_label" }));
        }
        if STARTUP_MARK_BUDGET
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_err()
        {
            return Ok(serde_json::json!({ "ok": true, "recorded": false, "reason": "budget_exhausted" }));
        }
        match request.client_epoch_ms {
            Some(ms) if ms.is_finite() => {
                shell_log(&format!("startup-mark [web:{label}] client_epoch_ms={ms}"));
            }
            _ => shell_log(&format!("startup-mark [web:{label}]")),
        }
        Ok(serde_json::json!({ "ok": true, "recorded": true }))
    }

    #[tauri::command]
    pub async fn desktop_runtime_start(
        app: tauri::AppHandle,
        request: DesktopStartRequest,
    ) -> Result<Value, String> {
        use std::sync::atomic::Ordering;
        // `app` (an owned, 'static AppHandle) is used instead of `State<'_>` so the
        // flag-clearing guard can live INSIDE the blocking task — see below.
        // P1: this command is ASYNC and does its blocking work on a blocking-pool
        // thread (below), so the Tauri/Wry main-thread event loop is NEVER blocked
        // during the (multi-second, cold) backend boot. That keeps the WKWebView
        // compositing — the static splash + StartupLoadingScreen animate the whole
        // time instead of the window freezing. The boot is not faster; it just no
        // longer freezes the UI.
        //
        // Re-entrancy guard: with the UI responsive during boot, a hard reload or
        // remount could fire a second concurrent start. CAS a flag so only the
        // first proceeds; a concurrent caller gets a clear, non-fatal error (the
        // frontend tolerates this and retries). This swap is SYNCHRONOUS and before
        // any `.await`, so cancellation can never skip it.
        if app
            .state::<SidecarOwnership>()
            .starting
            .swap(true, Ordering::SeqCst)
        {
            return Err("desktop runtime start already in progress".to_string());
        }
        // Build the command (and append our pid for the sidecar watchdog) on the
        // async side, then move ONLY owned data into the blocking task.
        let mut spec = build_desktop_start_command(&request);
        spec.args
            .extend(["--watch-ui-pid".to_string(), std::process::id().to_string()]);
        let entered_at = Instant::now();
        shell_log("startup-mark [rust:runtime_start_entered]");
        let guard_app = app.clone();
        // The blocking half: the one-time watchdog migration (which itself may cold-
        // start the frozen backend once) + the synchronous CLI wait for the sidecar
        // handle. Off-thread so it cannot freeze the UI.
        let join = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
            // Clear the re-entrancy flag when the BLOCKING WORK finishes, via a Drop
            // guard INSIDE the blocking task. This is the cancellation-safe spot: if
            // the outer async command future is dropped (e.g. a webview reload
            // abandons it at `join.await`), the code after the await never runs — so
            // clearing the flag there would wedge `starting=true` forever. The
            // blocking task itself always runs to completion, and clearing only when
            // it does (never earlier) means a second start can never begin while this
            // one's work is still in flight.
            struct StartingGuard(tauri::AppHandle);
            impl Drop for StartingGuard {
                fn drop(&mut self) {
                    self.0
                        .state::<SidecarOwnership>()
                        .starting
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
            let _guard = StartingGuard(guard_app);
            let migration_at = Instant::now();
            run_watchdog_migration_once();
            shell_log(&format!(
                "startup-mark [rust:watchdog_migration_done] took_ms={}",
                migration_at.elapsed().as_millis()
            ));
            shell_log("startup-mark [rust:cli_start_spawning]");
            let cli_at = Instant::now();
            let cli_result = invoke_cli_json(&spec);
            shell_log(&format!(
                "startup-mark [rust:cli_start_returned] took_ms={} ok={}",
                cli_at.elapsed().as_millis(),
                cli_result.is_ok()
            ));
            cli_result
        });
        let joined = join.await;
        let result = match joined {
            Ok(inner) => inner?,
            Err(err) => return Err(format!("desktop runtime start task failed: {err}")),
        };
        let owned = result
            .get("handle")
            .and_then(|h| h.get("owned"))
            .and_then(|o| o.as_bool());
        let pid = result
            .get("handle")
            .and_then(|h| h.get("pid"))
            .and_then(|p| p.as_u64());
        shell_log(&format!(
            "desktop_runtime_start: pid={pid:?} owned={owned:?} total_ms={} (watchdog owns teardown)",
            entered_at.elapsed().as_millis()
        ));
        Ok(result)
    }

    #[tauri::command]
    pub fn desktop_runtime_probe(request: DesktopProbeRequest) -> Result<Value, String> {
        invoke_cli_json(&build_desktop_probe_command(&request))
    }

    #[tauri::command]
    pub fn desktop_runtime_stop(request: DesktopStopRequest) -> Result<Value, String> {
        invoke_cli_json(&build_desktop_stop_command(&request))
    }

    #[tauri::command]
    pub fn desktop_set_window_theme(
        app: tauri::AppHandle,
        request: DesktopThemeRequest,
    ) -> Result<Value, String> {
        let theme = desktop_theme_from_preference(&request.theme)?;
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_theme(theme)
                .map_err(|err| format!("failed to set desktop window theme: {err}"))?;
        }
        Ok(serde_json::json!({ "ok": true, "theme": request.theme }))
    }

    #[tauri::command]
    pub fn desktop_start_window_drag(window: tauri::Window) -> Result<Value, String> {
        window
            .start_dragging()
            .map_err(|err| format!("failed to start desktop window drag: {err}"))?;
        Ok(serde_json::json!({ "ok": true }))
    }

    #[tauri::command]
    pub fn desktop_toggle_window_maximize(window: tauri::Window) -> Result<Value, String> {
        let maximized = window
            .is_maximized()
            .map_err(|err| format!("failed to inspect desktop window maximize state: {err}"))?;
        if maximized {
            window
                .unmaximize()
                .map_err(|err| format!("failed to unmaximize desktop window: {err}"))?;
        } else {
            window
                .maximize()
                .map_err(|err| format!("failed to maximize desktop window: {err}"))?;
        }
        Ok(serde_json::json!({ "ok": true, "maximized": !maximized }))
    }

    #[tauri::command]
    pub fn desktop_open_external_url(request: DesktopOpenUrlRequest) -> Result<Value, String> {
        open_external_url(&request)
    }

    #[tauri::command]
    pub fn desktop_reveal_path(request: DesktopRevealPathRequest) -> Result<Value, String> {
        reveal_path(&request)
    }

    #[tauri::command]
    pub fn desktop_reveal_image(request: DesktopRevealImageRequest) -> Result<Value, String> {
        reveal_image(&request)
    }

    #[tauri::command]
    pub fn desktop_set_webview_zoom(
        webview_window: tauri::WebviewWindow,
        request: DesktopZoomRequest,
    ) -> Result<Value, String> {
        if !request.factor.is_finite() || !(0.25..=4.0).contains(&request.factor) {
            return Err(format!("zoom factor out of range: {}", request.factor));
        }
        webview_window
            .set_zoom(request.factor)
            .map_err(|err| format!("failed to set webview zoom: {err}"))?;
        Ok(serde_json::json!({ "ok": true, "factor": request.factor }))
    }

    /// Open (or re-point) the native browser child webview overlaid on the
    /// reference panel. The first call creates the webview as a child of the
    /// main window at `rect`; later calls reuse it (navigate + reposition).
    ///
    /// This is a real, interactive browser surface (scripts, cookies, network
    /// all live) — the deliberate, owner-approved replacement for the sanitized
    /// reader. The child loads a *remote* origin and is granted NO `remote`
    /// capability, so Tauri's ACL denies every IPC command from it; the
    /// `browser_url_is_navigable` guard keeps it remote (it can never reach the
    /// app's local origin, which is the only way to flip that ACL open).
    #[tauri::command]
    pub fn desktop_browser_open(
        app: tauri::AppHandle,
        request: DesktopBrowserOpenRequest,
    ) -> Result<Value, String> {
        let url = parse_browser_url(&request.url)?;
        let bounds = browser_rect_to_tauri(&request.rect)?;

        if let Some(webview) = app.get_webview(REF_BROWSER_LABEL) {
            webview
                .set_bounds(bounds)
                .map_err(|err| format!("failed to position browser webview: {err}"))?;
            let _ = webview.show();
            webview
                .navigate(url.clone())
                .map_err(|err| format!("failed to navigate browser webview: {err}"))?;
            return Ok(serde_json::json!({ "ok": true, "url": url.as_str(), "reused": true }));
        }

        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let nav_app = app.clone();
        let load_app = app.clone();
        let popup_app = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(
            REF_BROWSER_LABEL,
            tauri::WebviewUrl::External(url.clone()),
        )
        .on_navigation(move |target| {
            // SECURITY: enforce the navigability boundary on EVERY navigation, not
            // just the initial open. Cancel anything that isn't public http(s) so a
            // remote page can't redirect to `tauri://`/loopback and gain `is_local`
            // IPC access (see browser_url_is_navigable).
            if !browser_url_is_navigable(target) {
                return false;
            }
            push_browser_event(
                &nav_app,
                &serde_json::json!({ "type": "navigated", "url": target.as_str() }),
            );
            true
        })
        .on_new_window(move |target, _features| {
            // `target="_blank"` / `window.open` would otherwise be silently dropped.
            // Open allowed targets in-place (single-view panel) and always Deny the
            // OS popup. Disallowed schemes/hosts are simply refused.
            if browser_url_is_navigable(&target) {
                if let Some(webview) = popup_app.get_webview(REF_BROWSER_LABEL) {
                    let _ = webview.navigate(target);
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            push_browser_event(
                &load_app,
                &serde_json::json!({ "type": "load", "phase": phase, "url": payload.url().as_str() }),
            );
        });
        window
            .add_child(builder, bounds.position, bounds.size)
            .map_err(|err| format!("failed to create browser webview: {err}"))?;
        Ok(serde_json::json!({ "ok": true, "url": url.as_str(), "reused": false }))
    }

    /// Reposition/resize the native browser webview to track the panel, or hide
    /// it (during a panel-divider drag, or when the panel is scrolled away). A
    /// no-op when the webview isn't open.
    #[tauri::command]
    pub fn desktop_browser_set_bounds(
        app: tauri::AppHandle,
        request: DesktopBrowserBoundsRequest,
    ) -> Result<Value, String> {
        let bounds = browser_rect_to_tauri(&request.rect)?;
        let Some(webview) = app.get_webview(REF_BROWSER_LABEL) else {
            return Ok(serde_json::json!({ "ok": true, "open": false }));
        };
        if request.hidden {
            let _ = webview.hide();
        } else {
            webview
                .set_bounds(bounds)
                .map_err(|err| format!("failed to position browser webview: {err}"))?;
            let _ = webview.show();
        }
        Ok(serde_json::json!({ "ok": true, "open": true, "hidden": request.hidden }))
    }

    /// Drive the native browser's own session history: `back` | `forward` |
    /// `reload`. Delegates to the engine's history, which no-ops at the ends.
    #[tauri::command]
    pub fn desktop_browser_navigate(
        app: tauri::AppHandle,
        request: DesktopBrowserNavigateRequest,
    ) -> Result<Value, String> {
        let script = match request.action.as_str() {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            other => return Err(format!("unknown browser navigate action: {other}")),
        };
        let Some(webview) = app.get_webview(REF_BROWSER_LABEL) else {
            return Ok(serde_json::json!({ "ok": true, "open": false }));
        };
        webview
            .eval(script)
            .map_err(|err| format!("failed to drive browser history: {err}"))?;
        Ok(serde_json::json!({ "ok": true, "open": true, "action": request.action }))
    }

    /// Tear down the native browser webview (panel closed / switched away). A
    /// no-op when nothing is open, so it is safe to call unconditionally.
    #[tauri::command]
    pub fn desktop_browser_close(app: tauri::AppHandle) -> Result<Value, String> {
        if let Some(webview) = app.get_webview(REF_BROWSER_LABEL) {
            webview
                .close()
                .map_err(|err| format!("failed to close browser webview: {err}"))?;
            return Ok(serde_json::json!({ "ok": true, "closed": true }));
        }
        Ok(serde_json::json!({ "ok": true, "closed": false }))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(config) = desktop_workbench_smoke_config() {
        match run_workbench_smoke(config) {
            Ok(success) => std::process::exit(if success { 0 } else { 1 }),
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    if let Some(config) = desktop_runtime_smoke_config() {
        match run_runtime_smoke(config) {
            Ok(success) => std::process::exit(if success { 0 } else { 1 }),
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    if let Some(config) = desktop_launch_smoke_config() {
        match run_launch_smoke(config) {
            Ok(()) => std::process::exit(0),
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    shell_log("desktop shell starting");
    tauri::Builder::default()
        // A second launch must not start a second shell (which would race the
        // startup self-heal sweep against the first instance's live sidecar);
        // instead, re-show and focus the existing window. Registered first so it
        // wins before any window/runtime work happens in the second process.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell_log("single-instance: second launch -> focusing existing window");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(SidecarOwnership::default())
        .setup(|app| {
            if maybe_schedule_workbench_smoke(app)? {
                return Ok(());
            }
            if maybe_schedule_runtime_smoke(app)? {
                return Ok(());
            }
            let _ = maybe_schedule_launch_smoke(app)?;
            // Startup tracing: the main window/webview exists by the time setup runs.
            // The span from "desktop shell starting" to here is the native window +
            // webview creation; the span from here to the webview's own `html-parse`
            // mark is how long WKWebView takes to begin parsing the bundled HTML.
            if app.get_webview_window("main").is_some() {
                shell_log("startup-mark [rust:window_created]");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS convention (Safari, Finder, Mail, …): Command+W / the red
            // close button hides the window and leaves the app — and its
            // backend runtime — alive in the background, rather than tearing
            // the whole shell down. We only intercept the user-initiated close
            // request; explicit `app.exit()` (Command+Q, smoke harness) is a
            // separate path and still terminates the process normally.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    use std::sync::atomic::Ordering;
                    let quitting = window.app_handle().state::<SidecarOwnership>().quitting.load(Ordering::SeqCst);
                    shell_log(&format!("WindowEvent::CloseRequested (quitting={quitting})"));
                    if !quitting {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_shell_info,
            commands::desktop_record_startup_mark,
            commands::desktop_runtime_start,
            commands::desktop_runtime_probe,
            commands::desktop_runtime_stop,
            commands::desktop_set_window_theme,
            commands::desktop_start_window_drag,
            commands::desktop_toggle_window_maximize,
            commands::desktop_open_external_url,
            commands::desktop_reveal_path,
            commands::desktop_reveal_image,
            commands::desktop_set_webview_zoom,
            commands::desktop_browser_open,
            commands::desktop_browser_set_bounds,
            commands::desktop_browser_navigate,
            commands::desktop_browser_close
        ])
        .build(tauri::generate_context!())
        .expect("error while running ClawHunt desktop")
        .run(|app_handle, event| {
            // Re-show the hidden main window when the user re-activates the app
            // from the Dock (clicking the icon while no window is visible).
            // Pairs with the CloseRequested hide above so the app behaves like
            // a normal background-capable macOS app.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                shell_log("RunEvent::Reopen — re-showing main window");
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // App is really quitting (Command+Q / Quit menu / last window closed
            // on Windows+Linux). The sidecar reaps ITSELF via its --watch-ui-pid
            // watchdog the instant this process exits, so there is no UI-side
            // teardown to run here — we only record it and mark `quitting` so the
            // CloseRequested handler stops hiding and lets the quit proceed.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use std::sync::atomic::Ordering;
                app_handle.state::<SidecarOwnership>().quitting.store(true, Ordering::SeqCst);
                shell_log("RunEvent::ExitRequested — quitting; sidecar watchdog will self-reap");
            }
        });
}

/// Best-effort append-only diagnostics for the packaged desktop shell. The
/// startup/exit lifecycle (and why a cleanup did or did not run) is otherwise
/// invisible in a shipped `.app`; this writes a timestamped line to
/// `<data root>/logs/desktop-shell.log` so failures are inspectable after the
/// fact. Never panics, never carries secrets (no tokens/URLs), and is a no-op if
/// the log location cannot be resolved or written.
fn shell_log(message: &str) {
    let Some(root) = desktop_data_root() else { return };
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let line = format!("{nanos} {message}\n");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop-shell.log"))
    {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

/// Marker-driven `desktop stop` (no `--pid`): the CLI resolves the running sidecar
/// from its on-disk handle and reaps it (signature-gated). Used only by the
/// one-time pre-watchdog migration.
fn build_desktop_stop_marker_command_for(cli_executable: Option<&str>) -> CommandSpec {
    let mut spec = cli_command_base(cli_executable);
    spec.args.push("stop".to_string());
    spec
}

fn build_desktop_stop_marker_command() -> CommandSpec {
    build_desktop_stop_marker_command_for(None)
}

/// Stamp file marking that the one-time pre-watchdog orphan migration has run. Its
/// presence makes `run_watchdog_migration_once` a no-op forever after.
fn watchdog_migration_stamp_path() -> Option<PathBuf> {
    desktop_data_root().map(|root| root.join("run").join(".watchdog-migrated"))
}

/// Reap a pre-watchdog orphan sidecar exactly once per machine, then stamp so it
/// never repeats (see the call site for why this is bounded to the upgrade
/// transition). Marker/signature-gated by the CLI; best-effort and never blocks
/// app start on failure. If the data root can't be resolved we skip (fail-safe:
/// never reap blindly).
fn run_watchdog_migration_once() {
    let Some(stamp) = watchdog_migration_stamp_path() else {
        shell_log("startup-mark [rust:watchdog_migration_skipped] reason=no_data_root");
        return;
    };
    if stamp.exists() {
        // The common case once a machine is migrated: a cheap stat, no frozen CLI
        // spawn. Logged so the trace distinguishes it from the expensive reap path.
        shell_log("startup-mark [rust:watchdog_migration_skipped] reason=already_stamped");
        return;
    }
    // The expensive path: spawns the frozen backend a SECOND time (a marker `desktop
    // stop`, up to 8s) before the real start — only on a machine without the stamp
    // (e.g. a fresh install's first launch). Trace its elapsed separately so it is
    // never confused with the sidecar boot itself.
    shell_log("startup-mark [rust:watchdog_migration_reap_begin]");
    let reap_at = Instant::now();
    let result = invoke_cli_json_with_timeout(&build_desktop_stop_marker_command(), Duration::from_secs(8));
    shell_log(&format!(
        "startup-mark [rust:watchdog_migration_reap_done] took_ms={} ok={}",
        reap_at.elapsed().as_millis(),
        result.is_ok()
    ));
    finish_watchdog_migration(&stamp, &result);
}

/// Strip control characters and bound the length of a webview-supplied startup
/// marker label so a relayed marker can never forge extra log lines (newlines) or
/// bloat `desktop-shell.log`. Pure — unit-tested without touching the filesystem.
fn sanitize_startup_mark_label(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(64).collect()
}

/// The fixed allowlist of startup phases the webview may record. Recording is
/// fail-closed: an unknown label is dropped, never written. Combined with the
/// process-wide budget below this bounds `desktop-shell.log` to a small, fixed
/// volume so a buggy or hostile renderer cannot grow the log without limit or
/// emit arbitrary phase strings (sanitize already strips control characters).
const STARTUP_MARK_LABELS: &[&str] = &[
    "html-parse",
    "dom-content-loaded",
    "first-paint",
    "first-contentful-paint",
    "react-bundle-evaluated",
    "react-render-called",
    "react-startup-screen-committed",
    "static-splash-hidden",
    "runtime-bootstrap-sent",
    "runtime-connected",
];

/// Process-wide cap on how many webview startup marks are ever written, as a
/// backstop against a renderer looping a *valid* label. Generous relative to the
/// ~10 marks a normal cold start emits (the paint observer may fire a couple), but
/// finite — once exhausted, further marks are dropped.
static STARTUP_MARK_BUDGET: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(256);

fn is_known_startup_mark(label: &str) -> bool {
    STARTUP_MARK_LABELS.contains(&label)
}

/// Stamp ONLY when the reap succeeded. A transient failure (timeout, a boot race,
/// the CLI momentarily unavailable) must NOT permanently mark the machine as
/// migrated — otherwise the one orphan it was meant to clear would be skipped
/// forever. On failure we leave no stamp so the next launch retries.
fn finish_watchdog_migration(stamp: &Path, result: &Result<Value, String>) {
    match result {
        Ok(value) => {
            shell_log(&format!("watchdog migration: reaped pre-watchdog orphan -> {value}"));
            if let Some(dir) = stamp.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(stamp, b"1");
        }
        Err(err) => {
            shell_log(&format!("watchdog migration: reap error {err} (no stamp — will retry next launch)"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::ffi::OsString;
    use std::sync::Mutex;

    #[test]
    fn startup_mark_label_strips_control_chars_and_bounds_length() {
        // Newlines/control chars would let a relayed marker forge extra log lines;
        // they must be stripped.
        assert_eq!(
            sanitize_startup_mark_label("first-paint\n2026-01-01 INJECTED"),
            "first-paint2026-01-01 INJECTED"
        );
        assert_eq!(sanitize_startup_mark_label("react\tmount\r\n"), "reactmount");
        // Length is bounded so a hostile/huge label cannot bloat the log line.
        let long = "x".repeat(500);
        assert_eq!(sanitize_startup_mark_label(&long).len(), 64);
        // Ordinary labels pass through untouched.
        assert_eq!(sanitize_startup_mark_label("dom-content-loaded"), "dom-content-loaded");
    }

    #[test]
    fn startup_mark_allowlist_is_fail_closed() {
        // Every label the frontend emits must be on the allowlist or it is dropped.
        for label in [
            "html-parse",
            "dom-content-loaded",
            "first-paint",
            "first-contentful-paint",
            "react-bundle-evaluated",
            "react-render-called",
            "react-startup-screen-committed",
            "static-splash-hidden",
            "runtime-bootstrap-sent",
            "runtime-connected",
        ] {
            assert!(is_known_startup_mark(label), "{label} must be allowed");
        }
        // Anything else (forged/unknown) is rejected.
        assert!(!is_known_startup_mark("rm -rf"));
        assert!(!is_known_startup_mark(""));
        assert!(!is_known_startup_mark("first-paintX"));
    }

    // Minimal valid headers so magic-byte + decode paths are exercised without
    // shipping real image fixtures. Only the leading bytes matter to the sniffer.
    const PNG_HEADER: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00];
    const JPEG_HEADER: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    const WEBP_HEADER: &[u8] = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn decode_image_accepts_allowlisted_types_with_matching_magic() {
        let (bytes, ext) =
            decode_and_validate_image("image/png", &b64(PNG_HEADER), MAX_REVEAL_IMAGE_BYTES).unwrap();
        assert_eq!(ext, "png");
        assert_eq!(bytes, PNG_HEADER);

        assert_eq!(
            decode_and_validate_image("image/jpeg", &b64(JPEG_HEADER), MAX_REVEAL_IMAGE_BYTES)
                .unwrap()
                .1,
            "jpg"
        );
        assert_eq!(
            decode_and_validate_image("image/webp", &b64(WEBP_HEADER), MAX_REVEAL_IMAGE_BYTES)
                .unwrap()
                .1,
            "webp"
        );
    }

    #[test]
    fn decode_image_rejects_unlisted_mime() {
        // SVG (script-capable) and arbitrary types are never materialized.
        let err = decode_and_validate_image("image/svg+xml", &b64(PNG_HEADER), MAX_REVEAL_IMAGE_BYTES)
            .unwrap_err();
        assert!(err.contains("unsupported image type"), "{err}");
    }

    #[test]
    fn decode_image_rejects_magic_mismatch() {
        // Declared PNG but the bytes are a JPEG header — the surface cannot lie about
        // the type to pick a favorable extension.
        let err = decode_and_validate_image("image/png", &b64(JPEG_HEADER), MAX_REVEAL_IMAGE_BYTES)
            .unwrap_err();
        assert!(err.contains("do not match declared type"), "{err}");
    }

    #[test]
    fn decode_image_rejects_bad_base64_and_empty_and_oversize() {
        assert!(decode_and_validate_image("image/png", "not base64!!!", MAX_REVEAL_IMAGE_BYTES)
            .unwrap_err()
            .contains("invalid image data"));
        assert!(decode_and_validate_image("image/png", "", MAX_REVEAL_IMAGE_BYTES)
            .unwrap_err()
            .contains("empty"));
        // A payload that decodes larger than the cap is rejected before any write.
        let err = decode_and_validate_image("image/png", &b64(PNG_HEADER), 4).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }

    #[test]
    fn sanitize_image_stem_is_path_safe() {
        // Directory components (traversal attempts) are dropped; only the base survives.
        assert_eq!(sanitize_image_stem(Some("../../etc/passwd")), "passwd");
        assert_eq!(sanitize_image_stem(Some("shot 2026!.PNG")), "shot-2026");
        assert_eq!(sanitize_image_stem(Some("clean-name.webp")), "clean-name");
        // Nothing usable → deterministic fallback.
        assert_eq!(sanitize_image_stem(Some("   ")), "image");
        assert_eq!(sanitize_image_stem(Some("....")), "image");
        assert_eq!(sanitize_image_stem(None), "image");
    }

    #[test]
    fn image_content_tag_is_stable_and_distinguishing() {
        // Same bytes → same tag (idempotent reveal); different bytes → different tag.
        assert_eq!(image_content_tag(PNG_HEADER), image_content_tag(PNG_HEADER));
        assert_ne!(image_content_tag(PNG_HEADER), image_content_tag(JPEG_HEADER));
        assert_eq!(image_content_tag(PNG_HEADER).len(), 16);
        // FNV-1a is a fixed algorithm, so the tag is pinned across toolchains: a
        // change here would silently orphan every previously-saved image.
        assert_eq!(image_content_tag(b"abc"), "e71fa2190541574b");
    }

    #[test]
    fn materialize_reveal_image_writes_validated_bytes_idempotently() {
        let _lock = lock_env();
        let _env = WorkdirEnvGuard::capture();
        let root = unique_temp_dir();
        env::set_var("SUPERCLAW_DESKTOP_WORKDIR", &root);

        let req = DesktopRevealImageRequest {
            mime: "image/png".to_string(),
            data_base64: b64(PNG_HEADER),
            name: Some("shot 1!.png".to_string()),
        };
        let path = materialize_reveal_image(&req).expect("materialize");
        // Written under <root>/saved-images/ with a sanitized, content-tagged name.
        assert!(path.starts_with(root.join("saved-images")));
        let fname = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(fname.starts_with("shot-1-"), "unexpected name: {fname}");
        assert!(fname.ends_with(".png"), "unexpected name: {fname}");
        assert_eq!(fs::read(&path).expect("read back"), PNG_HEADER);

        // Same bytes → same path (idempotent; no orphan pile-up on re-reveal).
        let again = materialize_reveal_image(&req).expect("materialize again");
        assert_eq!(again, path);

        // A rejected payload (off-allowlist mime) never writes a file.
        let bad = DesktopRevealImageRequest {
            mime: "image/svg+xml".to_string(),
            data_base64: b64(PNG_HEADER),
            name: None,
        };
        assert!(materialize_reveal_image(&bad).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    // SUPERCLAW_DESKTOP_WORKDIR is process-global; tests that set/clear it OR read it
    // (directly, or indirectly via desktop_shell_info_payload) must run serially or
    // they race under cargo's default multi-threaded runner — concurrent setenv +
    // getenv is undefined behaviour at the libc level. Every such test takes this
    // lock first.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // RAII restore of SUPERCLAW_DESKTOP_WORKDIR. Captures the prior value on
    // construction and restores it on Drop, so a panicking assertion mid-test can
    // never leak a mutated env var into sibling tests (the Drop runs during unwind).
    struct WorkdirEnvGuard(Option<OsString>);

    impl WorkdirEnvGuard {
        fn capture() -> Self {
            Self(env::var_os("SUPERCLAW_DESKTOP_WORKDIR"))
        }
    }

    impl Drop for WorkdirEnvGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => env::set_var("SUPERCLAW_DESKTOP_WORKDIR", value),
                None => env::remove_var("SUPERCLAW_DESKTOP_WORKDIR"),
            }
        }
    }

    fn unique_temp_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = env::temp_dir().join(format!("superclaw-desktop-test-{stamp}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).expect("write script");
        let mut perms = fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    fn shell_info_workspace_root_is_explicit_only() {
        let _lock = lock_env();
        let _env = WorkdirEnvGuard::capture();

        // Without an explicit workdir there is NO workspace root: the shell no
        // longer probes cwd or hardcoded ~/Documents paths (which on macOS would
        // trip the TCC "access your Documents folder" prompt and blank the first
        // frame). The data root falls through to Application Support instead.
        env::remove_var("SUPERCLAW_DESKTOP_WORKDIR");
        let bare = desktop_shell_info_payload();
        assert!(
            bare.workspace_root.is_none(),
            "no implicit workspace root without SUPERCLAW_DESKTOP_WORKDIR"
        );
        assert!(bare.workspace_update_command.is_none());

        // An explicit workdir is the ONLY way the workspace-relative fields populate.
        let dir = unique_temp_dir();
        env::set_var("SUPERCLAW_DESKTOP_WORKDIR", &dir);
        let info = desktop_shell_info_payload();

        assert_eq!(info.product_name, DEFAULT_PRODUCT_NAME);
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.release_channel, DEFAULT_RELEASE_CHANNEL);
        assert_eq!(info.update_mode, DEFAULT_UPDATE_MODE);
        assert_eq!(
            info.workspace_root.as_deref().map(PathBuf::from),
            Some(dir.clone())
        );
        assert_eq!(info.web_dev_url, DEFAULT_WEB_DEV_URL);
        assert!(info.web_dist_path.as_deref().is_some_and(|value| {
            PathBuf::from(value).ends_with(Path::new("apps").join("web").join("dist"))
        }));
        let expected_cli_suffix = if cfg!(windows) {
            Path::new(".venv").join("Scripts").join("superclaw.exe")
        } else {
            Path::new(".venv").join("bin").join("superclaw")
        };
        assert!(
            PathBuf::from(&info.cli_executable).ends_with(expected_cli_suffix)
                || info.cli_executable == DEFAULT_CLI_EXECUTABLE
        );
        assert!(info.update_guide_path.as_deref().is_some_and(|value| {
            PathBuf::from(value).ends_with(Path::new("docs").join("desktop-manual-update.md"))
        }));
        assert!(info
            .workspace_update_command
            .as_deref()
            .is_some_and(|value| {
                value.contains("git pull --ff-only")
                    && if cfg!(windows) {
                        value.contains(".venv\\Scripts\\python.exe")
                    } else {
                        value.contains(".venv/bin/python")
                    }
            }));
    }

    #[test]
    fn desktop_theme_preferences_map_to_tauri_theme() {
        assert_eq!(
            desktop_theme_from_preference("system").expect("system theme"),
            None
        );
        assert_eq!(
            desktop_theme_from_preference("light").expect("light theme"),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            desktop_theme_from_preference("dark").expect("dark theme"),
            Some(tauri::Theme::Dark)
        );
        assert!(desktop_theme_from_preference("sepia").is_err());
    }

    #[test]
    fn build_start_command_serializes_optional_fields() {
        let spec = build_desktop_start_command_for(
            &DesktopStartRequest {
                host: Some("127.0.0.1".to_string()),
                port: Some(8788),
                state_path: Some("/tmp/state.db".to_string()),
                control_token: Some("token".to_string()),
                connect_timeout_seconds: Some(0.25),
                boot_timeout_seconds: Some(5.0),
                log_level: Some("warning".to_string()),
            },
            Some("/tmp/superclaw"),
        );
        assert_eq!(
            spec,
            CommandSpec {
                executable: "/tmp/superclaw".to_string(),
                args: vec![
                    "desktop".to_string(),
                    "start".to_string(),
                    "--host".to_string(),
                    "127.0.0.1".to_string(),
                    "--port".to_string(),
                    "8788".to_string(),
                    "--state-path".to_string(),
                    "/tmp/state.db".to_string(),
                    "--control-token".to_string(),
                    "token".to_string(),
                    "--connect-timeout".to_string(),
                    "0.25".to_string(),
                    "--boot-timeout".to_string(),
                    "5.0".to_string(),
                    "--log-level".to_string(),
                    "warning".to_string(),
                ],
            }
        );
    }

    #[test]
    fn build_desktop_stop_marker_command_is_bare_marker_stop() {
        // One-time migration reap: `desktop stop` with no --pid -> the CLI resolves
        // and signature-gates the recorded sidecar (never a blind kill).
        let spec = build_desktop_stop_marker_command_for(Some("superclaw-dev"));
        assert_eq!(spec.args, vec!["desktop".to_string(), "stop".to_string()]);
        assert_eq!(spec.executable, "superclaw-dev".to_string());
    }

    #[test]
    fn watchdog_migration_stamps_only_on_success() {
        // The stamp path is explicit, but finish_watchdog_migration -> shell_log ->
        // desktop_data_root reads SUPERCLAW_DESKTOP_WORKDIR as a logging side effect;
        // lock so that read never races a concurrent env-mutating test.
        let _lock = lock_env();
        let dir = unique_temp_dir();
        let stamp = dir.join(".watchdog-migrated");

        // Failure -> no stamp, so the next launch retries the orphan reap.
        finish_watchdog_migration(&stamp, &Err("boot timeout".to_string()));
        assert!(!stamp.exists(), "must not stamp on a failed migration");

        // Success -> stamp, so it never runs again.
        finish_watchdog_migration(&stamp, &Ok(serde_json::json!({"ok": true})));
        assert!(stamp.exists(), "must stamp once the reap succeeds");
    }

    #[test]
    fn watchdog_migration_stamp_lives_under_run() {
        let _lock = lock_env();
        let _env = WorkdirEnvGuard::capture();
        // With an explicit workdir the stamp is deterministic: <root>/run/.watchdog-migrated.
        let dir = unique_temp_dir();
        env::set_var("SUPERCLAW_DESKTOP_WORKDIR", &dir);
        let stamp = watchdog_migration_stamp_path().expect("stamp path");
        assert_eq!(stamp, dir.join("run").join(".watchdog-migrated"));
    }

    #[test]
    fn build_probe_and_stop_commands_preserve_contract_shape() {
        let probe = build_desktop_probe_command_for(
            &DesktopProbeRequest {
                base_url: "http://127.0.0.1:8788".to_string(),
                control_token: Some("secret".to_string()),
                timeout_seconds: Some(0.1),
            },
            Some("superclaw-dev"),
        );
        let stop = build_desktop_stop_command_for(
            &DesktopStopRequest {
                pid: 8123,
                owned: Some(false),
                wait_timeout_seconds: Some(0.5),
            },
            Some("superclaw-dev"),
        );
        assert_eq!(
            probe.args,
            vec![
                "desktop".to_string(),
                "probe".to_string(),
                "--base-url".to_string(),
                "http://127.0.0.1:8788".to_string(),
                "--control-token".to_string(),
                "secret".to_string(),
                "--timeout".to_string(),
                "0.1".to_string(),
            ]
        );
        assert_eq!(
            stop.args,
            vec![
                "desktop".to_string(),
                "stop".to_string(),
                "--pid".to_string(),
                "8123".to_string(),
                "--no-owned".to_string(),
                "--wait-timeout".to_string(),
                "0.5".to_string(),
            ]
        );
    }


    #[test]
    fn invoke_cli_json_reads_machine_json_output() {
        // invoke_cli_json -> desktop_data_root reads SUPERCLAW_DESKTOP_WORKDIR; lock
        // so it never races a concurrent env-mutating test (setenv/getenv UB).
        let _lock = lock_env();
        let dir = unique_temp_dir();
        let script = write_script(
            &dir,
            "superclaw-ok.sh",
            "#!/bin/sh\nprintf '{\"ok\":true,\"handle\":{\"owned\":true}}'\n",
        );
        let spec = CommandSpec {
            executable: script.display().to_string(),
            args: vec![],
        };
        let payload = invoke_cli_json(&spec).expect("invoke ok");
        assert_eq!(payload["ok"], Value::Bool(true));
        assert_eq!(payload["handle"]["owned"], Value::Bool(true));
    }

    #[test]
    fn invoke_cli_json_surfaces_nonzero_exit() {
        let _lock = lock_env();
        let dir = unique_temp_dir();
        let script = write_script(
            &dir,
            "superclaw-fail.sh",
            "#!/bin/sh\necho 'desktop failed' 1>&2\nexit 7\n",
        );
        let spec = CommandSpec {
            executable: script.display().to_string(),
            args: vec!["desktop".to_string(), "start".to_string()],
        };
        let error = invoke_cli_json(&spec).expect_err("invoke should fail");
        assert!(error.contains("failed with exit code 7"));
        assert!(error.contains("desktop failed"));
    }

    #[test]
    fn invoke_cli_json_times_out_hung_command() {
        let _lock = lock_env();
        let dir = unique_temp_dir();
        let script = write_script(&dir, "superclaw-hangs.sh", "#!/bin/sh\nsleep 2\n");
        let spec = CommandSpec {
            executable: script.display().to_string(),
            args: vec!["desktop".to_string(), "start".to_string()],
        };
        let error = invoke_cli_json_with_timeout(&spec, Duration::from_millis(100))
            .expect_err("invoke should time out");
        assert!(error.contains("timed out after"));
        assert!(error.contains("no output"));
    }

    #[test]
    fn smoke_payload_preserves_shell_identity() {
        // Reads SUPERCLAW_DESKTOP_WORKDIR via desktop_shell_info_payload; serialize
        // against the env-mutating tests so setenv/getenv never race.
        let _lock = lock_env();
        let info = desktop_shell_info_payload();
        let payload = build_desktop_launch_smoke_payload(&info);
        assert_eq!(payload.product_name, info.product_name);
        assert_eq!(payload.version, info.version);
        assert_eq!(payload.release_channel, info.release_channel);
        assert_eq!(payload.update_mode, info.update_mode);
        assert_eq!(payload.workspace_root, info.workspace_root);
        assert_eq!(payload.web_dist_path, info.web_dist_path);
        assert_eq!(payload.cli_executable, info.cli_executable);
        assert!(payload.pid > 0);
        assert!(payload.launched_at_epoch_ms > 0);
    }

    #[test]
    fn smoke_payload_write_creates_parent_directory() {
        // Reads SUPERCLAW_DESKTOP_WORKDIR via desktop_shell_info_payload; serialize
        // against the env-mutating tests so setenv/getenv never race.
        let _lock = lock_env();
        let dir = unique_temp_dir();
        let target = dir.join("nested").join("desktop-smoke.json");
        let payload = build_desktop_launch_smoke_payload(&desktop_shell_info_payload());
        write_desktop_launch_smoke_payload(&target, &payload).expect("write smoke payload");
        let rendered = fs::read_to_string(&target).expect("read smoke payload");
        assert!(rendered.contains("\"productName\""));
        assert!(rendered.contains("\"pid\""));
    }

    #[test]
    fn runtime_smoke_config_honors_env_overrides() {
        let dir = unique_temp_dir();
        let smoke_path = dir.join("runtime-smoke.json");
        let state_path = dir.join("runtime-state.db");
        unsafe {
            env::set_var("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_FILE", &smoke_path);
            env::set_var("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_STATE_PATH", &state_path);
        }
        let config = desktop_runtime_smoke_config().expect("runtime smoke config");
        assert_eq!(config.path, smoke_path);
        assert_eq!(config.state_path, state_path);
        unsafe {
            env::remove_var("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_FILE");
            env::remove_var("SUPERCLAW_DESKTOP_RUNTIME_SMOKE_STATE_PATH");
        }
    }

    #[test]
    fn workbench_smoke_config_honors_env_overrides() {
        let dir = unique_temp_dir();
        let smoke_path = dir.join("workbench-smoke.json");
        let state_path = dir.join("workbench-state.db");
        unsafe {
            env::set_var("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_FILE", &smoke_path);
            env::set_var("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_STATE_PATH", &state_path);
            env::set_var("SUPERCLAW_DESKTOP_WORKBENCH_CHAT_BACKEND", "codex");
            env::set_var("SUPERCLAW_DESKTOP_WORKBENCH_RUN_BACKEND", "local");
        }
        let config = desktop_workbench_smoke_config().expect("workbench smoke config");
        assert_eq!(config.path, smoke_path);
        assert_eq!(config.state_path, state_path);
        assert_eq!(config.chat_backend, "codex");
        assert_eq!(config.run_backend, "local");
        unsafe {
            env::remove_var("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_FILE");
            env::remove_var("SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_STATE_PATH");
            env::remove_var("SUPERCLAW_DESKTOP_WORKBENCH_CHAT_BACKEND");
            env::remove_var("SUPERCLAW_DESKTOP_WORKBENCH_RUN_BACKEND");
        }
    }

    #[test]
    fn desktop_external_url_accepts_only_clean_http_urls() {
        assert_eq!(
            normalize_external_url(" https://clawhunt.store/login?source=superclaw ").unwrap(),
            "https://clawhunt.store/login?source=superclaw"
        );
        assert_eq!(
            normalize_external_url("http://127.0.0.1:8787/callback").unwrap(),
            "http://127.0.0.1:8787/callback"
        );
        assert!(normalize_external_url("").is_err());
        assert!(normalize_external_url("file:///Applications/ClawHunt.app").is_err());
        assert!(normalize_external_url("javascript:alert(1)").is_err());
        assert!(normalize_external_url("https://clawhunt.store/login page").is_err());
        assert!(normalize_external_url("https://clawhunt.store/\"&calc&\"").is_err());
        assert!(normalize_external_url("https://clawhunt.store/'login'").is_err());
        assert!(normalize_external_url("https://clawhunt.store/\nlogin").is_err());
    }

    #[test]
    fn parse_browser_url_accepts_only_clean_http_and_parses() {
        // Shares the external-URL guard, then parses into a navigable URL.
        let url = parse_browser_url(" https://japantoday.com/ ").expect("clean https");
        assert_eq!(url.as_str(), "https://japantoday.com/");
        assert!(parse_browser_url("file:///etc/passwd").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("https://exa mple.com").is_err());
        assert!(parse_browser_url("").is_err());
    }

    #[test]
    fn browser_url_is_navigable_allows_public_http_only() {
        let nav = |s: &str| browser_url_is_navigable(&s.parse::<tauri::Url>().unwrap());
        // Public http(s) → allowed.
        assert!(nav("https://japantoday.com/"));
        assert!(nav("http://example.org/path?q=1"));
        assert!(nav("https://192.0.2.10/")); // public IP literal
                                             // Non-http(s) schemes (the app-origin escape vector) → blocked.
        assert!(!nav("tauri://localhost/"));
        assert!(!nav("file:///etc/passwd"));
        assert!(!nav("data:text/html,<h1>x"));
        // Loopback / unspecified / *.localhost → blocked (can't reach the app origin
        // and flip to is_local).
        assert!(!nav("http://localhost:5173/"));
        assert!(!nav("http://app.localhost/"));
        assert!(!nav("http://127.0.0.1:8765/health"));
        assert!(!nav("http://127.0.0.42/")); // whole 127/8 loopback range
        assert!(!nav("http://[::1]:8765/"));
        assert!(!nav("http://0.0.0.0/"));
        // IPv4-mapped / -compatible loopback in IPv6 form → still blocked (routes to
        // the v4 loopback; is_loopback() alone would miss these).
        assert!(!nav("http://[::ffff:127.0.0.1]/"));
        assert!(!nav("http://[::ffff:7f00:1]/"));
        assert!(!nav("http://[::127.0.0.1]/"));
        // Private / LAN hosts are INTENTIONALLY allowed (real browser, not the
        // SSRF-guarded reader); none of these is ever the app origin.
        assert!(nav("http://192.168.1.1/"));
        assert!(nav("http://10.0.0.5/"));
        assert!(nav("http://[fe80::1]/"));
    }

    #[test]
    fn parse_browser_url_rejects_loopback_targets() {
        assert!(parse_browser_url("http://127.0.0.1:5173/").is_err());
        assert!(parse_browser_url("http://localhost/").is_err());
        assert!(parse_browser_url("https://japantoday.com/").is_ok());
    }

    #[test]
    fn browser_rect_to_tauri_rejects_non_finite_and_clamps_negative() {
        let rect = browser_rect_to_tauri(&BrowserRect {
            x: 12.0,
            y: 34.0,
            width: 800.0,
            height: 600.0,
        })
        .expect("finite rect");
        match (rect.position, rect.size) {
            (tauri::Position::Logical(pos), tauri::Size::Logical(size)) => {
                assert_eq!((pos.x, pos.y), (12.0, 34.0));
                assert_eq!((size.width, size.height), (800.0, 600.0));
            }
            _ => panic!("expected logical position/size"),
        }

        // Negative extents clamp to zero (never hand the platform a negative box).
        let clamped = browser_rect_to_tauri(&BrowserRect {
            x: 0.0,
            y: 0.0,
            width: -5.0,
            height: -1.0,
        })
        .expect("clamped rect");
        if let tauri::Size::Logical(size) = clamped.size {
            assert_eq!((size.width, size.height), (0.0, 0.0));
        } else {
            panic!("expected logical size");
        }

        // Non-finite components are rejected outright.
        assert!(browser_rect_to_tauri(&BrowserRect {
            x: f64::NAN,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        })
        .is_err());
        assert!(browser_rect_to_tauri(&BrowserRect {
            x: 0.0,
            y: 0.0,
            width: f64::INFINITY,
            height: 1.0,
        })
        .is_err());
    }
}
