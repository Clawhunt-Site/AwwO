#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// AwwO 本地版 for Windows: a window for the local runtime (scripts/awwo-local.mjs, docs/awwo-local-edition.md). It starts
// the runtime from the files installed beside it, with a data folder of this account's own, shows its progress on a
// page of its own, and opens AwwO at the address the runtime reports once it is ready. Closing the window stops the
// runtime in order (its standard input closes) and waits for it. The pages it shows get no native commands: AwwO is
// the runtime's own web app, and the status page is told what happens through script the shell runs in it and the
// fragment of its address.

use std::collections::hash_map::RandomState;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::hash::BuildHasher;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const MENU_RESTART: &str = "restart";
const MENU_FOLDER: &str = "folder";
const MENU_LOGS: &str = "logs";
const MENU_BROWSER: &str = "browser";
const MENU_RESET: &str = "reset";
const MENU_QUIT: &str = "quit";
/// The host WebView2 serves the app's own files from on Windows: the status page.
const SHELL_HOST: &str = "tauri.localhost";
/// A runtime that has not stopped this long after its stdin closed is ended: its services end with it, and the
/// database it leaves is stopped. Its own orderly stop takes at most about three minutes.
const STOP_DEADLINE: Duration = Duration::from_secs(240);
/// How long the end of a runtime waits for the last lines it wrote (the error it ended on) to be read.
const LAST_LINES: Duration = Duration::from_secs(5);
/// Asks the running window to stop AwwO 本地版 in order and exit (the installer's hooks, installer-hooks.nsh); started
/// with it while none runs, the app stops a database an earlier run left and exits.
const QUIT_FLAG: &str = "--quit";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static NEXT_POPUP_ID: AtomicU64 = AtomicU64::new(1);
/// Set with Runtime.exiting, and read without the runtime's lock: a refusal of the installation's check, shown in the
/// check's turn, is not shown over an exit's page.
static EXITING: AtomicBool = AtomicBool::new(false);
static NEXT_PAGE_UPDATE: AtomicU64 = AtomicU64::new(1);

/// What follows a stop of the runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AfterStop {
    Exit,
    Restart { reset: bool },
}

/// A second request during a stop: an exit wins over a restart, and a restart asked with a reset keeps the reset.
fn merged(pending: AfterStop, asked: AfterStop) -> AfterStop {
    match (pending, asked) {
        (AfterStop::Exit, _) | (_, AfterStop::Exit) => AfterStop::Exit,
        (AfterStop::Restart { reset: first }, AfterStop::Restart { reset: second }) => AfterStop::Restart { reset: first || second },
    }
}

/// The runtime this window runs.
#[derive(Default)]
struct Runtime {
    /// Its standard input: closing it stops the runtime in order (--stop-on-stdin-close).
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
    /// Which start it is: the deadline of a stop ends only the runtime it was set for.
    generation: u64,
    /// The address it serves this data folder under, once ready.
    origin: Option<Url>,
    /// Set while a stop is under way, with what follows it.
    after: Option<AfterStop>,
    /// A runtime has ended and what it left is being stopped: requests wait for it (merged into after).
    cleaning: bool,
    /// The start whose runtime the deadline ends: the thread waiting for it ends it, holding its process (whose id no
    /// other process can take while it is held).
    kill: Option<u64>,
    /// The error it last reported: what its end is shown with, when it stops by itself.
    error: Option<String>,
    /// The app is exiting: nothing starts again.
    exiting: bool,
}

type Shared = Arc<Mutex<Runtime>>;

fn lock(shared: &Shared) -> MutexGuard<'_, Runtime> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the installed runtime, its code and this account's data are.
struct Paths {
    /// The installation (this program's folder) and its payload, which holds the code and the build.
    install: PathBuf,
    payload: PathBuf,
    node: PathBuf,
    script: PathBuf,
    code: PathBuf,
    build: PathBuf,
    /// The data folder, in the shell's folder (%LOCALAPPDATA%\store.clawhunt.awwo.local, with WebView2's data and the
    /// logs), kept apart from the installation so an update or an uninstall leaves it. The runtime keeps it to what is
    /// its own (and private to this account).
    state: PathBuf,
    /// The runtime's own log (its standard error), in a folder of its own: "open the logs" opens no secret. Each
    /// service's log is in the data folder's logs.
    logs: PathBuf,
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    // Tauri canonicalizes its own executable's path, which on Windows writes it with the verbatim prefix (\\?\C:\…);
    // PostgreSQL's tools find each other by the path they were started with and cannot start from one written so.
    let resources = dunce::simplified(&app.path().resource_dir().map_err(|error| error.to_string())?).to_path_buf();
    let payload = payload_dir(resources.join("payload"));
    let code = payload.join("app");
    let build = payload.join("build");
    let home = dunce::simplified(&app.path().app_local_data_dir().map_err(|error| error.to_string())?).to_path_buf();
    Ok(Paths {
        install: resources,
        payload,
        node: build.join("node").join("node.exe"),
        script: code.join("scripts").join("awwo-local.mjs"),
        code,
        build,
        state: home.join("state"),
        logs: home.join("logs"),
    })
}

/// A development build can run a payload assembled elsewhere (AWWO_LOCAL_PAYLOAD); a release runs what it installed.
fn payload_dir(installed: PathBuf) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("AWWO_LOCAL_PAYLOAD") {
        return PathBuf::from(dir);
    }
    installed
}

/// A program of Windows' own, by its full path: a bare name would be looked for beside this app first.
fn system_program(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(name)
}

/// This process's token in the status page's address. Only the shell's own navigations carry it: it is in no address a
/// page can read, so no page can show text of its own on the shell's page.
fn shell_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        // Random keys of the standard library's hasher, from the operating system's generator.
        let state = RandomState::new();
        format!("{:016x}{:016x}", state.hash_one(1u8), state.hash_one(2u8))
    })
}

/// Percent-encodes everything but the unreserved characters, for the status page to read with decodeURIComponent.
fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The status page's address with an update: {kind: "step", step}, {kind: "message", text} or {kind: "error", text},
/// numbered, so the page tells two updates with the same text apart (it applies each fragment it is given).
fn shell_page(update: &serde_json::Value) -> Option<Url> {
    let mut update = update.clone();
    update["n"] = NEXT_PAGE_UPDATE.fetch_add(1, Ordering::Relaxed).into();
    Url::parse(&format!("http://{SHELL_HOST}/index.html?t={}#{}", shell_token(), encode_component(&update.to_string()))).ok()
}

/// Tells the status page what happens. The page AwwO itself is in has no awwoStatus, so there it does nothing.
fn show(app: &AppHandle, update: &serde_json::Value) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&format!("window.awwoStatus && window.awwoStatus({update})"));
    }
}

/// Back to the status page, with the update it shows (it reads it from the address, as it may load after an eval).
fn show_page(app: &AppHandle, update: &serde_json::Value) {
    if let (Some(window), Some(url)) = (app.get_webview_window("main"), shell_page(update)) {
        let _ = window.navigate(url);
    }
}

fn message(kind: &str, text: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "kind": kind, "text": text.into() })
}

/// Opens an address in the browser (or a mail program), a folder in Explorer or a file in the program it opens in,
/// through the shell's handler for it: one string, with no command line to parse (Explorer splits its own at commas).
/// On the main thread, where the shell's handlers expect to be called.
fn open(app: &AppHandle, target: impl Into<OsString>) {
    let target = target.into();
    let _ = app.run_on_main_thread(move || shell_open(&target));
}

#[cfg(windows)]
fn shell_open(target: &OsStr) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &OsStr| text.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide(OsStr::new("open")), wide(target));
    // SAFETY: both strings end in NUL and outlive the call; the window, parameters and directory may be null.
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}
#[cfg(not(windows))]
fn shell_open(_target: &OsStr) {}

/// A command that shows no console window.
fn quiet(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The rights of an access list's entry that change a folder or what is in it: write and append data (make files and
/// folders), write extended attributes and attributes, delete children and itself, change the access list or the
/// owner, generic write and generic all.
const WRITE_RIGHTS: u64 = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x4000_0000 | 0x1000_0000;
/// Each path's access list, one line a path: `owner|protected|type,inherited,inheritance,propagation,rights,sid;…`,
/// every SID in full (the runtime's ACL_SCRIPT, scripts/awwo-local-lib.mjs); MISSING for a path that is not there.
const ACL_SCRIPT: &str = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.SecurityIdentifier]; \
    foreach ($p in $env:AWWO_ACL_PATHS.Split('|')) { if (Test-Path -LiteralPath $p) { $acl = Get-Acl -LiteralPath $p; \
    $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object { '{0},{1},{2},{3},{4},{5}' -f $_.AccessControlType, $_.IsInherited, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [int]$_.FileSystemRights, $_.IdentityReference.Value }); \
    '{0}|{1}|{2}' -f $acl.GetOwner($sid).Value, $acl.AreAccessRulesProtected, ($rules -join ';') } else { 'MISSING' } }";

/// Who may change an installation besides the account: SYSTEM, Administrators, TrustedInstaller; CREATOR OWNER and
/// OWNER RIGHTS (whoever makes or owns a file there); a domain's admins and enterprise admins (administrators of the
/// computer already); and the account's own sandboxed apps (app packages and capabilities, which run as it:
/// %LOCALAPPDATA% grants some).
fn trusted_writer(sid: &str, account: &str) -> bool {
    sid == account
        || matches!(sid, "S-1-5-18" | "S-1-5-32-544" | "S-1-3-0" | "S-1-3-4" | "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
        || sid.starts_with("S-1-15-2-")
        || sid.starts_with("S-1-15-3-")
        || (sid.starts_with("S-1-5-21-") && (sid.ends_with("-512") || sid.ends_with("-519")))
}

/// Who else an access list (ACL_SCRIPT's line) lets change what it guards: the SID of each allow entry with a write
/// right, whether it applies there or passes to what is inside; an owner not trusted, who could give itself any right;
/// everyone, where the list has no entry (an absent list, which Windows reads as no limit); and an entry not read.
fn others_who_may_write(line: &str, account: &str) -> Vec<String> {
    let mut fields = line.trim().splitn(3, '|');
    let owner = fields.next().unwrap_or_default();
    let entries = fields.nth(1).unwrap_or_default();
    let mut writers = Vec::new();
    if entries.is_empty() {
        writers.push("everyone (no access list)".to_string());
    }
    for entry in entries.split(';').filter(|entry| !entry.is_empty()) {
        let parts: Vec<&str> = entry.split(',').collect();
        let rights = parts.get(4).and_then(|rights| rights.parse::<i64>().ok());
        match (parts.len(), rights) {
            (6, Some(rights)) if parts[0] != "Allow" || rights as u64 & WRITE_RIGHTS == 0 || trusted_writer(parts[5], account) => {}
            (6, Some(_)) => writers.push(parts[5].to_string()),
            _ => writers.push(format!("an entry not read ({entry})")),
        }
    }
    if !trusted_writer(owner, account) {
        writers.push(format!("{owner} (its owner)"));
    }
    writers.sort();
    writers.dedup();
    writers
}

/// Whether the installation's folders (this program's, the payload's, the code's and the build's), each read where it
/// really is (a junction's target), are this account's to change, with no link inside the payload: another account
/// that could change them could have AwwO run its code with this account's keys. Asked of System32's whoami and
/// Windows PowerShell (as the runtime asks of its data folder), before anything of the payload runs (the runtime,
/// pg_ctl); a pass is kept for the rest of this program's run, a refusal asked again at the next start.
fn installation_trusted(paths: &Paths) -> Result<(), String> {
    trusted_in_turn(paths, |_| {})
}

/// installation_trusted, with what a refusal does (`refused`) done in the check's turn. Checks run one at a time, and
/// one that waited for its turn finds a pass made meanwhile; so a refusal is on the page before a later check, which
/// may pass and start AwwO, has begun, and the start's pages come after it.
#[cfg(windows)]
fn trusted_in_turn(paths: &Paths, refused: impl FnOnce(&str)) -> Result<(), String> {
    static PASSED: OnceLock<()> = OnceLock::new();
    static CHECKING: Mutex<()> = Mutex::new(());
    if PASSED.get().is_some() {
        return Ok(());
    }
    let _turn = CHECKING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if PASSED.get().is_some() {
        return Ok(());
    }
    match check_installation(&[&paths.install, &paths.payload, &paths.code, &paths.build], &paths.payload) {
        Ok(()) => {
            let _ = PASSED.set(());
            Ok(())
        }
        Err(problem) => {
            refused(&problem);
            Err(problem)
        }
    }
}
#[cfg(not(windows))]
fn trusted_in_turn(_paths: &Paths, _refused: impl FnOnce(&str)) -> Result<(), String> {
    Ok(())
}

/// How long whoami and Windows PowerShell may take to answer the installation's check: a first PowerShell an antivirus
/// scans takes seconds; one that does not answer at all stops the start, instead of holding it.
#[cfg(windows)]
const CHECK_DEADLINE: Duration = Duration::from_secs(60);

/// A program's output once it has ended, or an error once `limit` has passed (it is then ended). Its output is read
/// within the deadline too: a process it started could hold the pipes open after it ended.
#[cfg(windows)]
fn output_within(command: &mut Command, limit: Duration) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::time::Instant;
    let timed_out = || std::io::Error::new(std::io::ErrorKind::TimedOut, format!("no answer in {} s", limit.as_secs()));
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    // Both pipes are drained while it runs, so a long output cannot stop it.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (sent, received) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = sent.send(bytes);
        });
        received
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            ended => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ended.err().unwrap_or_else(timed_out));
            }
        }
    };
    // What is left of the deadline, and a moment for pipes that close as it ends.
    let read = |pipe: mpsc::Receiver<Vec<u8>>| pipe.recv_timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_secs(2))).map_err(|_| timed_out());
    Ok(std::process::Output { status, stdout: read(stdout)?, stderr: read(stderr)? })
}

/// The first link (a junction or a symbolic link) at any depth inside a folder, which is not followed. The installer
/// makes none, and the packager refuses a payload that holds one; one made since (a tool that moved a folder to another
/// drive leaves a junction) leads to a folder whose permissions no one checked. An entry that cannot be read is an
/// error: what it is cannot be told.
#[cfg(windows)]
fn link_inside(folder: &Path) -> Result<Option<PathBuf>, String> {
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
            let kind = entry.file_type().map_err(|error| format!("{}: {error}", entry.path().display()))?;
            if kind.is_symlink() {
                return Ok(Some(entry.path()));
            }
            if kind.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(None)
}

#[cfg(windows)]
fn check_installation(folders: &[&Path], payload: &Path) -> Result<(), String> {
    // A development build running a payload assembled elsewhere (AWWO_LOCAL_PAYLOAD) is not an installation.
    #[cfg(debug_assertions)]
    if std::env::var_os("AWWO_LOCAL_PAYLOAD").is_some() {
        return Ok(());
    }
    let unread = |what: String| format!("无法读取 AwwO 本地版安装位置的权限（{what}）：Windows PowerShell 被限制时无法检查，本地版因此不启动。\nThe permissions of AwwO Local's installation could not be read ({what}): where Windows PowerShell is restricted they cannot be checked, and AwwO Local does not start.");
    let who = output_within(quiet(system_program("whoami.exe")).args(["/user", "/fo", "csv", "/nh"]), CHECK_DEADLINE).map_err(|error| unread(format!("whoami: {error}")))?;
    let account = String::from_utf8_lossy(&who.stdout).trim().rsplit(',').next().unwrap_or_default().trim_matches('"').to_string();
    if !who.status.success() || !account.starts_with("S-1-") {
        return Err(unread("whoami".into()));
    }
    let real: Vec<PathBuf> = folders.iter().map(|folder| dunce::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf())).collect();
    let joined = real.iter().map(|folder| folder.to_string_lossy().into_owned()).collect::<Vec<_>>().join("|");
    let listed = output_within(
        quiet(system_program("WindowsPowerShell\\v1.0\\powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT])
            .env_clear()
            .env("SystemRoot", std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .env("AWWO_ACL_PATHS", joined),
        CHECK_DEADLINE,
    )
    .map_err(|error| unread(format!("Windows PowerShell: {error}")))?;
    let lines: Vec<String> = String::from_utf8_lossy(&listed.stdout).lines().map(|line| line.trim().to_string()).filter(|line| !line.is_empty()).collect();
    if !listed.status.success() || lines.len() != real.len() {
        return Err(unread(String::from_utf8_lossy(&listed.stderr).lines().next().unwrap_or("Windows PowerShell").to_string()));
    }
    let open: Vec<String> = real
        .iter()
        .zip(&lines)
        .filter_map(|(folder, line)| {
            let writers = if line == "MISSING" { vec!["(missing)".to_string()] } else { others_who_may_write(line, &account) };
            (!writers.is_empty()).then(|| format!("{}: {}", folder.display(), writers.join(", ")))
        })
        .collect();
    if !open.is_empty() {
        let open = open.join("; ");
        return Err(format!("AwwO 本地版安装在这台电脑上其他账号也能改动的位置（{open}）。请卸载后重新安装到你的用户目录，即安装程序建议的位置。\nAwwO Local is installed where other accounts on this computer may change its programs ({open}). Uninstall it and install it again in your user folder, where the installer suggests."));
    }
    let payload = dunce::canonicalize(payload).unwrap_or_else(|_| payload.to_path_buf());
    match link_inside(&payload) {
        Ok(None) => Ok(()),
        Ok(Some(link)) => Err(format!("AwwO 本地版的安装目录里有一个链接（{}），它可能把程序引到别的账号也能改动的地方。请卸载后重新安装。\nAwwO Local's installation holds a link ({}), which may lead its programs to a place other accounts can change. Uninstall it and install it again.", link.display(), link.display())),
        Err(error) => Err(format!("无法读取 AwwO 本地版的安装目录（{error}），本地版因此不启动。请卸载后重新安装。\nAwwO Local's installation could not be read ({error}), and AwwO Local does not start. Uninstall it and install it again.")),
    }
}

/// The data folder held against any runtime, by its runtime.lock opened as a runtime opens it (exclusively): None while
/// a runtime runs on it. While held, a runtime starting on it stops at once (the folder is in use).
#[cfg(windows)]
fn hold_data_folder(paths: &Paths) -> Option<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new().read(true).write(true).create(true).share_mode(0).open(paths.state.join("runtime.lock")).ok()
}
#[cfg(not(windows))]
fn hold_data_folder(_paths: &Paths) -> Option<fs::File> {
    None
}

/// A path as PostgreSQL's programs are given it, as the runtime gives them theirs (postgresPath in
/// scripts/awwo-local-lib.mjs): they get their paths in the system's ANSI code page, a character it has not as "?", so
/// a path that is not ASCII is given in its short (8.3) form when the volume keeps one; as it is otherwise.
#[cfg(windows)]
fn postgres_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    if path.to_str().is_some_and(str::is_ascii) {
        return path.to_path_buf();
    }
    let long: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut short = vec![0u16; 32_768];
    // SAFETY: both buffers live through the call, the first ends in a zero and the second holds the length given.
    let length = unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) } as usize;
    if length == 0 || length >= short.len() {
        return path.to_path_buf();
    }
    short.truncate(length);
    PathBuf::from(OsString::from_wide(&short))
}
#[cfg(not(windows))]
fn postgres_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// Stops the PostgreSQL a runtime that ended without stopping it left running (ended by the deadline or from outside,
/// or crashed): pg_ctl starts the server outside the runtime's processes, so it outlives them. Only with no runtime on
/// the data folder, which stays held until the server has stopped.
fn stop_leftover_database(paths: &Paths) {
    let pg_ctl = paths.build.join("pgsql").join("bin").join("pg_ctl.exe");
    let data = paths.state.join("postgres");
    // Only the installation's own pg_ctl, in folders no other account may change.
    if !pg_ctl.exists() || !data.join("postmaster.pid").exists() || installation_trusted(paths).is_err() {
        return;
    }
    let Some(_held) = hold_data_folder(paths) else { return };
    let (pg_ctl, data) = (postgres_path(&pg_ctl), postgres_path(&data));
    let run = |args: &[&str]| {
        quiet(&pg_ctl).arg("-D").arg(&data).args(args).env("LC_MESSAGES", "C").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    // pg_ctl status: 0 while the server runs.
    if run(&["status"]).ok().and_then(|status| status.code()) == Some(0) {
        let _ = run(&["-m", "fast", "-w", "-t", "60", "stop"]);
    }
}

/// Checks the installation, then does `then`; a refusal is shown instead, in the check's turn (trusted_in_turn). Run
/// off the main thread and outside the runtime's lock: the check can take seconds (a pass is kept, so the one a start
/// makes under the lock is then at once).
fn checked_then(app: &AppHandle, then: impl FnOnce(&AppHandle)) {
    if let Ok(paths) = paths(app) {
        if trusted_in_turn(&paths, |problem| show_refusal(app, problem)).is_err() {
            return;
        }
    }
    then(app);
}

/// A refusal of the installation's check, shown unless the app is exiting, whose page says so.
fn show_refusal(app: &AppHandle, problem: &str) {
    if !EXITING.load(Ordering::SeqCst) {
        show_page(app, &message("error", problem));
    }
}

fn start(app: &AppHandle, shared: &Shared, reset: bool) {
    let runtime = lock(shared);
    if runtime.pid.is_some() || runtime.exiting || runtime.cleaning {
        return;
    }
    launch(app, shared, runtime, reset);
}

/// Starts the runtime under the lock its caller holds and decided by, so nothing starts another meanwhile (a restart
/// and a menu click at the same moment start one runtime, and a reset asked is the one that starts).
fn launch(app: &AppHandle, shared: &Shared, mut runtime: MutexGuard<'_, Runtime>, reset: bool) {
    // The app is exiting: nothing starts again (stop and start refuse it first; this is the last word).
    if runtime.exiting {
        return;
    }
    let paths = match paths(app) {
        Ok(paths) => paths,
        Err(error) => {
            drop(runtime);
            return show_page(app, &message("error", format!("找不到 AwwO 本地版的文件：{error}\nAwwO Local's files were not found.")));
        }
    };
    if !paths.node.exists() || !paths.script.exists() {
        drop(runtime);
        return show_page(app, &message("error", "AwwO 本地版的文件不完整，请重新安装。\nAwwO Local's files are incomplete: install it again."));
    }
    if trusted_in_turn(&paths, |problem| show_refusal(app, problem)).is_err() {
        drop(runtime);
        return;
    }
    let _ = fs::create_dir_all(&paths.logs);
    let log = OpenOptions::new().create(true).append(true).open(paths.logs.join("runtime.log"));
    let mut command = quiet(&paths.node);
    command
        .arg(&paths.script)
        .args(["--events", "--stop-on-stdin-close", "--shell", "windows", "--parent-pid", &std::process::id().to_string()])
        .arg("--resources")
        .arg(&paths.code)
        .arg("--build")
        .arg(&paths.build)
        .arg("--state")
        .arg(&paths.state)
        .current_dir(&paths.code)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log.map(Stdio::from).unwrap_or_else(|_| Stdio::null()));
    // The installed runtime runs as installed: not with the person's Node.js settings (NODE_OPTIONS can load code) or a
    // PostgreSQL of a checkout's (AWWO_LOCAL_PG_BIN).
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("NODE_") || name == "AWWO_LOCAL_PG_BIN" {
            command.env_remove(&key);
        }
    }
    if reset {
        command.arg("--reset-password");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            drop(runtime);
            return show_page(app, &message("error", format!("AwwO 本地版没有启动：{error}\nAwwO Local did not start: {error}")));
        }
    };
    let stdout = child.stdout.take();
    runtime.stdin = child.stdin.take();
    runtime.pid = Some(child.id());
    runtime.generation += 1;
    let generation = runtime.generation;
    runtime.origin = None;
    runtime.error = None;
    runtime.kill = None;
    drop(runtime);
    if reset {
        // The new password's file opens at the next start that is ready, this one or a later one.
        let _ = fs::remove_file(credentials_marker(&paths.state));
    }
    let (lines_done, lines_read) = mpsc::channel::<()>();
    if let Some(stdout) = stdout {
        let (app, shared, state) = (app.clone(), shared.clone(), paths.state.clone());
        thread::spawn(move || {
            // Read as bytes, so a line that is not UTF-8 is still read and the pipe never stops being drained.
            let (mut reader, mut line) = (BufReader::new(stdout), Vec::new());
            while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
                event(&app, &shared, &state, String::from_utf8_lossy(&line).trim_end());
                line.clear();
            }
            let _ = lines_done.send(());
        });
    }
    let (app, shared) = (app.clone(), shared.clone());
    thread::spawn(move || {
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => break child.wait().ok(),
            }
            // The deadline's end, made here, while this thread holds the process: its id is its own until then.
            if lock(&shared).kill.take_if(|asked| *asked == generation).is_some() {
                let _ = quiet(system_program("taskkill.exe")).args(["/PID", &child.id().to_string(), "/T", "/F"]).status();
                // Should taskkill not run or fail, the runtime itself ends, on the handle held here; its services end
                // as their pipes close.
                let _ = child.kill();
            }
            thread::sleep(Duration::from_millis(250));
        };
        let _ = lines_read.recv_timeout(LAST_LINES);
        exited(&app, &shared, status);
    });
}

/// One line the runtime wrote on its standard output (--events).
fn event(app: &AppHandle, shared: &Shared, state: &Path, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return };
    match value.get("event").and_then(|event| event.as_str()) {
        Some("status") => {
            if let Some(step) = value.get("step").and_then(|step| step.as_str()) {
                show(app, &serde_json::json!({ "kind": "step", "step": step }));
            }
        }
        Some("ready") => {
            let Some(url) = value.get("url").and_then(|url| url.as_str()).and_then(|url| Url::parse(url).ok()) else { return };
            if !runtime_origin(&url) {
                return show_page(app, &message("error", format!("AwwO 本地版报告了一个意外的地址：{url}\nAwwO Local reported an unexpected address.")));
            }
            {
                let mut runtime = lock(shared);
                // Ready as it is being stopped (a line still in the pipe): the stop's page stays.
                if runtime.after.is_some() {
                    return;
                }
                runtime.origin = Some(url.clone());
                // Sent under the lock (navigate only queues it): a stop decided next queues its page after this one.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.navigate(url.clone());
                }
            }
            // The sign-in file opens the first time this data folder is ready (it has a name of its own, the
            // address's host), and after a password reset (which removes the marker): a start that failed before it
            // was ready leaves it for the next one.
            let host = url.host_str().unwrap_or_default().to_string();
            let marker = credentials_marker(state);
            if fs::read_to_string(&marker).ok().as_deref() != Some(host.as_str()) {
                open(app, state.join("admin-credentials.txt"));
                let _ = fs::write(&marker, &host);
            }
        }
        Some("error") => {
            let text = value.get("message").and_then(|text| text.as_str()).unwrap_or("").to_string();
            lock(shared).error = Some(text.clone());
            show_page(app, &message("error", text));
        }
        _ => {}
    }
}

/// Where the shell notes the data folder whose sign-in file it has shown (beside the data folder, in its own folder).
fn credentials_marker(state: &Path) -> PathBuf {
    state.parent().map(|home| home.join("credentials-shown")).unwrap_or_else(|| state.join("..").join("credentials-shown"))
}

/// The runtime serves only http on a *.localhost name of the data folder's own (localOrigin in awwo-local-lib.mjs).
fn runtime_origin(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str().is_some_and(|host| host.ends_with(".localhost")) && url.port().is_some() && url.username().is_empty() && url.password().is_none()
}

fn exited(app: &AppHandle, shared: &Shared, status: Option<ExitStatus>) {
    let error = {
        let mut runtime = lock(shared);
        runtime.stdin = None;
        runtime.pid = None;
        runtime.origin = None;
        runtime.cleaning = true;
        runtime.error.take()
    };
    // A runtime that was ended (by the deadline, or from outside) or crashed leaves its database running; one that
    // stopped in order leaves none, and this only asks. Before anything follows, and with what is asked meanwhile
    // waiting for it: a restart's runtime takes the folder.
    if let Ok(paths) = paths(app) {
        stop_leftover_database(&paths);
    }
    let mut runtime = lock(shared);
    runtime.cleaning = false;
    match runtime.after.take() {
        Some(AfterStop::Exit) => {
            drop(runtime);
            app.exit(0);
        }
        Some(AfterStop::Restart { reset }) => {
            show_page(app, &message("message", "正在重新启动… Restarting…"));
            launch(app, shared, runtime, reset);
        }
        None => {
            let code = status.and_then(|status| status.code()).map(|code| code.to_string()).unwrap_or_else(|| "?".into());
            let why = error.map(|error| format!("{error}\n\n")).unwrap_or_default();
            // Shown under the lock: a restart asked next shows its own page after this one.
            show_page(app, &message("error", format!(
                "{why}AwwO 本地版已停止（{code}）。用菜单「AwwO → 重新启动」再启动；「打开日志」里有它的日志。\nAwwO Local stopped ({code}). Use AwwO → Restart to start it again; its logs are under AwwO → Open the logs.")));
            drop(runtime);
        }
    }
}

/// Stops the runtime in order, then exits or starts it again. An exit asked during a stop wins over a restart.
/// Whether a stop asked now goes on. An exit asked is under way from then on: what is asked after it (a restart a
/// menu click's thread asks late) does nothing, even once the runtime has ended and the app has yet to exit.
fn stop_goes_on(runtime: &mut Runtime, after: AfterStop) -> bool {
    if runtime.exiting {
        return false;
    }
    if after == AfterStop::Exit {
        runtime.exiting = true;
    }
    true
}

fn stop(app: &AppHandle, shared: &Shared, after: AfterStop) {
    let generation = {
        let mut runtime = lock(shared);
        if !stop_goes_on(&mut runtime, after) {
            return;
        }
        if runtime.exiting {
            EXITING.store(true, Ordering::SeqCst);
        }
        // A stop, or the end of a runtime, under way: this follows it.
        if runtime.after.is_some() || runtime.cleaning {
            runtime.after = Some(runtime.after.map_or(after, |pending| merged(pending, after)));
            return;
        }
        if runtime.pid.is_none() {
            match after {
                AfterStop::Exit => {
                    runtime.cleaning = true;
                    drop(runtime);
                    // No runtime to stop: a database one that was ended left (Task Manager) is stopped instead, so an
                    // update that asked this window to quit finds nothing running. Off the main thread, which pg_ctl
                    // would hold for up to a minute.
                    show_page(app, &message("message", "正在停止 AwwO 本地版… Stopping AwwO Local…"));
                    let app = app.clone();
                    thread::spawn(move || {
                        if let Ok(paths) = paths(&app) {
                            stop_leftover_database(&paths);
                        }
                        app.exit(0);
                    });
                }
                AfterStop::Restart { reset } => launch(app, shared, runtime, reset),
            }
            return;
        }
        runtime.after = Some(after);
        // Closing the pipe is the runtime's polite stop (--stop-on-stdin-close).
        runtime.stdin = None;
        runtime.generation
    };
    show_page(app, &message("message", "正在停止 AwwO 本地版… Stopping AwwO Local…"));
    let shared = shared.clone();
    thread::spawn(move || {
        thread::sleep(STOP_DEADLINE);
        let mut runtime = lock(&shared);
        if runtime.pid.is_some() && runtime.generation == generation {
            runtime.kill = Some(generation);
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum NavigationAction {
    Stay,
    OpenExternal,
    Deny,
}

/// Only the status page (in the main window, at the shell's own navigations) and the runtime's own address stay in a
/// window; another web address, or a mail address, opens in its program. A popup may begin blank, as window.open does.
fn navigation_action(target: &Url, origin: Option<&Url>, popup: bool) -> NavigationAction {
    if !target.username().is_empty() || target.password().is_some() {
        return NavigationAction::Deny;
    }
    match target.scheme() {
        "about" if target.as_str() == "about:blank" && popup => NavigationAction::Stay,
        "http" | "https" if target.host_str() == Some(SHELL_HOST) && target.port().is_none() => {
            let ours = target.query_pairs().any(|(key, value)| key == "t" && value == shell_token());
            // The plain page the window opens on stays until the runtime is ready.
            let opening = origin.is_none() && target.query().is_none() && target.fragment().is_none();
            if !popup && target.scheme() == "http" && (ours || opening) {
                NavigationAction::Stay
            } else {
                NavigationAction::Deny
            }
        }
        "http" | "https" => {
            if origin.is_some_and(|origin| target.origin() == origin.origin()) {
                NavigationAction::Stay
            } else {
                NavigationAction::OpenExternal
            }
        }
        // A file the app makes for download (a blob of its own page).
        "blob" => match (origin, Url::parse(target.path())) {
            (Some(origin), Ok(inner)) if inner.origin() == origin.origin() => NavigationAction::Stay,
            _ => NavigationAction::Deny,
        },
        "mailto" => NavigationAction::OpenExternal,
        _ => NavigationAction::Deny,
    }
}

/// The address another program is given: a mail address with its subject and body alone (a mailto's other fields, an
/// attach= among them, would have some mail programs attach a file of this computer's), any other address as it is.
fn external_address(target: &Url) -> String {
    if target.scheme() != "mailto" {
        return target.to_string();
    }
    let kept: Vec<String> = target
        .query_pairs()
        .filter(|(key, _)| key.eq_ignore_ascii_case("subject") || key.eq_ignore_ascii_case("body"))
        .map(|(key, value)| format!("{}={}", key.to_ascii_lowercase(), encode_component(&value)))
        .collect();
    let address = format!("mailto:{}", target.path());
    if kept.is_empty() {
        address
    } else {
        format!("{address}?{}", kept.join("&"))
    }
}

fn navigate(app: &AppHandle, target: &Url, shared: &Shared, popup: bool) -> bool {
    let origin = lock(shared).origin.clone();
    match navigation_action(target, origin.as_ref(), popup) {
        NavigationAction::Stay => true,
        NavigationAction::OpenExternal => {
            open(app, external_address(target));
            false
        }
        NavigationAction::Deny => false,
    }
}

/// A window AwwO opens (a preview, a page of its own in a new tab): its own address in a window of this app, sharing
/// its sign-in, anything else in the browser.
fn new_window(handle: &AppHandle, shared: &Shared, url: Url, features: tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;
    let origin = lock(shared).origin.clone();
    match navigation_action(&url, origin.as_ref(), true) {
        NavigationAction::Stay => {
            let label = format!("window-{}", NEXT_POPUP_ID.fetch_add(1, Ordering::Relaxed));
            let (nav_shared, nav_handle, child_shared, child_handle) = (shared.clone(), handle.clone(), shared.clone(), handle.clone());
            let builder = WebviewWindowBuilder::new(handle, label, WebviewUrl::External(Url::parse("about:blank").expect("static URL")))
                .window_features(features)
                .title("AwwO 本地版")
                .on_navigation(move |target| navigate(&nav_handle, target, &nav_shared, true))
                .on_new_window(move |url, features| new_window(&child_handle, &child_shared, url, features));
            match builder.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        }
        NavigationAction::OpenExternal => {
            open(handle, external_address(&url));
            NewWindowResponse::Deny
        }
        NavigationAction::Deny => NewWindowResponse::Deny,
    }
}

fn main() {
    let shared: Shared = Arc::new(Mutex::new(Runtime::default()));
    let (instance_shared, menu_shared, setup_shared, run_shared) = (shared.clone(), shared.clone(), shared.clone(), shared.clone());
    let quit_only = std::env::args().skip(1).any(|arg| arg == QUIT_FLAG);
    tauri::Builder::default()
        // A second start hands its arguments to this window and ends.
        .plugin(tauri_plugin_single_instance::init(move |app, argv, _| {
            if argv.iter().skip(1).any(|arg| arg == QUIT_FLAG) {
                stop(app, &instance_shared, AfterStop::Exit);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .on_menu_event(move |app, event| {
            let paths = paths(app).ok();
            match event.id().as_ref() {
                // A restart after a refused check checks again: off the main thread, as the first start does.
                MENU_RESTART | MENU_RESET => {
                    let (handle, shared, reset) = (app.clone(), menu_shared.clone(), event.id().as_ref() == MENU_RESET);
                    thread::spawn(move || checked_then(&handle, move |app| stop(app, &shared, AfterStop::Restart { reset })));
                }
                MENU_QUIT => stop(app, &menu_shared, AfterStop::Exit),
                MENU_FOLDER => {
                    if let Some(paths) = paths {
                        open(app, paths.state);
                    }
                }
                MENU_LOGS => {
                    if let Some(paths) = paths {
                        let _ = fs::create_dir_all(&paths.logs);
                        open(app, paths.logs);
                    }
                }
                MENU_BROWSER => {
                    // Read, then opened with the lock released: opening runs here on the main thread, where a
                    // navigation reported meanwhile would take the lock again.
                    let origin = lock(&menu_shared).origin.clone();
                    if let Some(origin) = origin {
                        open(app, origin.as_str());
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            if quit_only {
                // No window runs to be asked: what an earlier run left of AwwO 本地版 is stopped instead.
                lock(&setup_shared).exiting = true;
                EXITING.store(true, Ordering::SeqCst);
                if let Ok(paths) = paths(app.handle()) {
                    stop_leftover_database(&paths);
                }
                app.handle().exit(0);
                return Ok(());
            }
            let menu = MenuBuilder::new(app)
                .item(
                    &SubmenuBuilder::new(app, "AwwO")
                        .text(MENU_RESTART, "重新启动 Restart")
                        .text(MENU_BROWSER, "在浏览器中打开 Open in browser")
                        .separator()
                        .text(MENU_FOLDER, "打开数据目录 Open the data folder")
                        .text(MENU_LOGS, "打开日志 Open the logs")
                        .separator()
                        .text(MENU_RESET, "重置登录密码（重新启动） Reset the sign-in password (restarts)")
                        .separator()
                        .text(MENU_QUIT, "退出 Quit")
                        .build()?,
                )
                .build()?;
            app.set_menu(menu)?;
            let (nav_shared, nav_handle, popup_shared, popup_handle) = (setup_shared.clone(), app.handle().clone(), setup_shared.clone(), app.handle().clone());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AwwO 本地版")
                .inner_size(1480.0, 960.0)
                .min_inner_size(1000.0, 680.0)
                .on_navigation(move |url| navigate(&nav_handle, url, &nav_shared, false))
                .on_new_window(move |url, features| new_window(&popup_handle, &popup_shared, url, features))
                .build()?;
            // The first start checks the installation (installation_trusted), which takes seconds where an antivirus
            // scans Windows PowerShell: off the main thread, and before the runtime's lock is taken (the window's
            // navigations take it on the main thread), so the window shows its page meanwhile. A pass is kept, and
            // the start's own check under the lock is then at once.
            let (first_handle, first_shared) = (app.handle().clone(), setup_shared.clone());
            thread::spawn(move || checked_then(&first_handle, move |app| start(app, &first_shared, false)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("AwwO Local could not start")
        .run(move |app, event| match event {
            // Closing the main window stops the runtime first; the app exits once it has stopped.
            RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
                api.prevent_close();
                stop(app, &run_shared, AfterStop::Exit);
            }
            RunEvent::ExitRequested { api, .. } => {
                let running = lock(&run_shared).pid.is_some();
                if running {
                    api.prevent_exit();
                    stop(app, &run_shared, AfterStop::Exit);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{encode_component, external_address, merged, navigation_action, others_who_may_write, runtime_origin, shell_page, shell_token, AfterStop, NavigationAction};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn only_the_shells_own_page_and_the_runtime_stay_in_the_window() {
        let origin = url("http://awwo-0123456789ab.localhost:5199");
        let ours = shell_page(&serde_json::json!({ "kind": "error", "text": "100% 停止" })).unwrap();
        for stay in [ours.as_str(), "http://awwo-0123456789ab.localhost:5199/?tenant=a", "blob:http://awwo-0123456789ab.localhost:5199/1f2e"] {
            assert_eq!(navigation_action(&url(stay), Some(&origin), false), NavigationAction::Stay, "{stay}");
        }
        for external in ["https://awwo.clawhunt.store/", "http://awwo.localhost:5199/", "http://awwo-0123456789ab.localhost:5200/", "https://example.com/", "mailto:a@example.com"] {
            assert_eq!(navigation_action(&url(external), Some(&origin), false), NavigationAction::OpenExternal, "{external}");
        }
        for deny in [
            "file:///C:/Users/a/secret.txt",
            "javascript:alert(1)",
            "http://user:pass@awwo-0123456789ab.localhost:5199/",
            "blob:https://example.com/x",
            // A page's own link to the shell's page, with text of its own: no token.
            "http://tauri.localhost/index.html#%7B%22kind%22%3A%22error%22%2C%22text%22%3A%22update%22%7D",
            "http://tauri.localhost/index.html?t=0000#x",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "about:blank",
        ] {
            assert_eq!(navigation_action(&url(deny), Some(&origin), false), NavigationAction::Deny, "{deny}");
        }
        // Before the runtime is ready: the plain page the window opens on, and nothing of an address not yet known.
        assert_eq!(navigation_action(&url("http://tauri.localhost/"), None, false), NavigationAction::Stay);
        assert_eq!(navigation_action(&url("http://tauri.localhost/index.html#x"), None, false), NavigationAction::Deny);
        assert_eq!(navigation_action(&url("http://awwo-0123456789ab.localhost:5199/"), None, false), NavigationAction::OpenExternal);
        assert_eq!(navigation_action(&url("http://tauri.localhost:8080/"), None, false), NavigationAction::OpenExternal);
    }

    #[test]
    fn a_popup_may_begin_blank_but_never_shows_the_shells_page() {
        let origin = url("http://awwo-0123456789ab.localhost:5199");
        let ours = shell_page(&serde_json::json!({ "kind": "message", "text": "x" })).unwrap();
        assert_eq!(navigation_action(&url("about:blank"), Some(&origin), true), NavigationAction::Stay);
        assert_eq!(navigation_action(&ours, Some(&origin), true), NavigationAction::Deny);
        assert_eq!(navigation_action(&url("http://tauri.localhost/"), None, true), NavigationAction::Deny);
        assert_eq!(navigation_action(&url("http://awwo-0123456789ab.localhost:5199/preview"), Some(&origin), true), NavigationAction::Stay);
    }

    #[test]
    fn the_status_pages_update_is_numbered_and_fully_encoded() {
        let first = shell_page(&serde_json::json!({ "kind": "error", "text": "100% 停止 #1" })).unwrap();
        let second = shell_page(&serde_json::json!({ "kind": "error", "text": "100% 停止 #1" })).unwrap();
        assert_ne!(first.fragment(), second.fragment(), "the same text twice is two updates");
        assert!(first.query().unwrap().contains(shell_token()));
        let fragment = first.fragment().unwrap();
        assert!(!fragment.contains('#') && !fragment.contains(' ') && fragment.contains("100%25"), "{fragment}");
        assert_eq!(encode_component("a-b_c.d~e /%\"é"), "a-b_c.d~e%20%2F%25%22%C3%A9");
    }

    #[test]
    fn a_mail_address_reaches_the_mail_program_with_its_subject_and_body_alone() {
        let given = url("mailto:ada@example.com?subject=Hi%20there&attach=C:%5CUsers%5Ca%5Clocal.env&body=Line%201&Attachment=x");
        assert_eq!(external_address(&given), "mailto:ada@example.com?subject=Hi%20there&body=Line%201");
        assert_eq!(external_address(&url("mailto:ada@example.com?attach=x")), "mailto:ada@example.com");
        assert_eq!(external_address(&url("https://example.com/a?attach=x")), "https://example.com/a?attach=x");
    }

    #[test]
    fn a_second_request_during_a_stop_keeps_an_exit_and_a_reset() {
        let (exit, restart, reset) = (AfterStop::Exit, AfterStop::Restart { reset: false }, AfterStop::Restart { reset: true });
        assert_eq!(merged(restart, reset), reset, "restart, then reset the password: the reset is kept");
        assert_eq!(merged(reset, restart), reset);
        assert_eq!(merged(restart, restart), restart);
        for (pending, asked) in [(restart, exit), (reset, exit), (exit, restart), (exit, reset)] {
            assert_eq!(merged(pending, asked), exit, "{pending:?} then {asked:?}");
        }
    }

    #[test]
    fn the_runtime_may_only_report_a_localhost_name_of_its_own() {
        assert!(runtime_origin(&url("http://awwo-0123456789ab.localhost:5199")));
        for bad in ["https://awwo-0123456789ab.localhost:5199", "http://evil.example:5199", "http://127.0.0.1:5199", "http://awwo.localhost", "http://a:b@x.localhost:1"] {
            assert!(!runtime_origin(&url(bad)), "{bad}");
        }
    }

    // Access lists as ACL_SCRIPT prints them. 2032127 is full control, 1245631 modify, 1179817 read and run.
    const ME: &str = "S-1-5-21-1-2-3-1001";
    fn line(owner: &str, entries: &[(&str, i64, &str)]) -> String {
        let entries: Vec<String> = entries.iter().map(|(kind, rights, sid)| format!("{kind},True,3,0,{rights},{sid}")).collect();
        format!("{owner}|False|{}", entries.join(";"))
    }

    #[test]
    fn an_installation_is_trusted_when_no_one_else_may_change_it() {
        // As under %LOCALAPPDATA%: SYSTEM, Administrators and the account, with a capability of its own sandboxed apps.
        let profile = line(ME, &[("Allow", 2032127, "S-1-5-18"), ("Allow", 2032127, "S-1-5-32-544"), ("Allow", 2032127, ME), ("Allow", 1245631, "S-1-15-3-3557520199-3666692283-3112367039-3524159787-2791857073-3163583606-3692855932")]);
        assert!(others_who_may_write(&profile, ME).is_empty());
        // A domain's admins and TrustedInstaller are administrators already; read-and-run grants nothing to write.
        let managed = line(ME, &[("Allow", 2032127, "S-1-5-21-9-9-9-512"), ("Allow", 2032127, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), ("Allow", 1179817, "S-1-5-32-545")]);
        assert!(others_who_may_write(&managed, ME).is_empty());
        // As under a drive's root: Authenticated Users may modify; a deny entry lets nobody in.
        let drive = line(ME, &[("Allow", 2032127, ME), ("Allow", 1245631, "S-1-5-11"), ("Deny", 2032127, "S-1-1-0")]);
        assert_eq!(others_who_may_write(&drive, ME), vec!["S-1-5-11"]);
        // Making files is enough; GENERIC_WRITE, as an inherit-only entry carries it, too.
        assert_eq!(others_who_may_write(&line(ME, &[("Allow", 0x2, "S-1-1-0")]), ME), vec!["S-1-1-0"]);
        assert_eq!(others_who_may_write(&line(ME, &[("Allow", 0x4000_0000, "S-1-5-21-9-9-9-1002")]), ME), vec!["S-1-5-21-9-9-9-1002"]);
        // GENERIC_READ alone, which PowerShell prints negative, is no write.
        assert!(others_who_may_write(&line(ME, &[("Allow", -2147483648, "S-1-5-21-9-9-9-1002")]), ME).is_empty());
        // An owner who could give itself any right, no list at all, and an entry not read are each reasons.
        assert_eq!(others_who_may_write(&line("S-1-5-21-9-9-9-1002", &[("Allow", 2032127, ME)]), ME), vec!["S-1-5-21-9-9-9-1002 (its owner)"]);
        assert_eq!(others_who_may_write(&format!("{ME}|True|"), ME), vec!["everyone (no access list)"]);
        assert_eq!(others_who_may_write(&format!("{ME}|False|Allow,True,3"), ME), vec!["an entry not read (Allow,True,3)"]);
    }

    #[test]
    fn nothing_asked_after_an_exit_goes_on() {
        use super::{stop_goes_on, Runtime};
        let mut runtime = Runtime::default();
        assert!(stop_goes_on(&mut runtime, AfterStop::Restart { reset: false }));
        assert!(!runtime.exiting, "a restart is no exit");
        assert!(stop_goes_on(&mut runtime, AfterStop::Exit));
        assert!(runtime.exiting, "the exit is under way from when it is asked");
        assert!(!stop_goes_on(&mut runtime, AfterStop::Restart { reset: true }), "a restart asked late starts nothing");
        assert!(!stop_goes_on(&mut runtime, AfterStop::Exit), "nor does a second exit ask anything");
    }

    #[cfg(windows)]
    #[test]
    fn a_link_anywhere_inside_the_payload_is_found_and_not_followed() {
        use super::{link_inside, system_program};
        let root = std::env::temp_dir().join(format!("awwo-links-{}", std::process::id()));
        let elsewhere = std::env::temp_dir().join(format!("awwo-elsewhere-{}", std::process::id()));
        std::fs::create_dir_all(root.join("build").join("node")).unwrap();
        std::fs::create_dir_all(elsewhere.join("deeper")).unwrap();
        std::fs::write(root.join("build").join("node").join("node.exe"), b"").unwrap();
        let clean = link_inside(&root);
        // A junction, as a tool that moved a folder to another drive leaves one (mklink /J needs no privilege).
        let junction = root.join("build").join("node").join("moved");
        let made = std::process::Command::new(system_program("cmd.exe")).args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&elsewhere).output().unwrap();
        let found = link_inside(&root);
        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
        assert_eq!(clean, Ok(None));
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        assert_eq!(found, Ok(Some(junction)));
        assert!(link_inside(&root).is_err(), "a folder that cannot be read is an error");
    }

    #[cfg(windows)]
    #[test]
    fn a_check_program_that_does_not_answer_is_ended_at_its_deadline() {
        use super::{output_within, quiet, system_program};
        use std::time::{Duration, Instant};
        let answered = output_within(quiet(system_program("whoami.exe")).args(["/user", "/fo", "csv", "/nh"]), Duration::from_secs(60)).unwrap();
        assert!(answered.status.success() && String::from_utf8_lossy(&answered.stdout).contains("S-1-"));
        let started = Instant::now();
        let silent = output_within(quiet(system_program("PING.EXE")).args(["-n", "30", "127.0.0.1"]), Duration::from_secs(1));
        assert_eq!(silent.map_err(|error| error.kind()).err(), Some(std::io::ErrorKind::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    }

    #[cfg(windows)]
    #[test]
    fn postgres_is_given_the_short_form_of_a_path_that_is_not_ascii() {
        use super::postgres_path;
        use std::path::Path;
        // ASCII is given as it is, and so is a path with no short form to give (one that does not exist).
        assert_eq!(postgres_path(Path::new(r"C:\Windows\System32")), Path::new(r"C:\Windows\System32"));
        assert_eq!(postgres_path(Path::new(r"C:\no such 文件夹\pg_ctl.exe")), Path::new(r"C:\no such 文件夹\pg_ctl.exe"));
        // A folder with characters a Chinese Windows's code page has not: its short form when the volume keeps one,
        // which is ASCII then, and always leads back to it.
        let folder = std::env::temp_dir().join(format!("awwo 한글 😀 {}", std::process::id()));
        std::fs::create_dir(&folder).unwrap();
        let given = postgres_path(&folder);
        let same = std::fs::canonicalize(&given).ok() == std::fs::canonicalize(&folder).ok();
        std::fs::remove_dir(&folder).unwrap();
        assert!(same, "{} does not lead back to {}", given.display(), folder.display());
        assert!(given == folder || given.to_str().is_some_and(str::is_ascii), "{}", given.display());
    }
}
