import AppKit
import WebKit
import Darwin
import Security

private enum WorkspaceMode: String { case cloud, local }
private final class RuntimeOutputBuffer { var data = Data() }

// AwwO 本地版 in this app (docs/awwo-local-edition.md): the payload apps/macos/build.ts puts in Contents/Resources/payload
// (scripts/awwo-local-package-macos.mjs), its runtime started with the flags AwwO Local's Windows window gives it,
// and this account's data in a folder of the app's own, apart from the folder an earlier build's local mode used
// (~/Library/Application Support/AwwO Local, which is never touched).
private struct LocalPaths {
    let node: URL
    let script: URL
    let code: URL
    let build: URL
    /// ~/Library/Application Support/store.clawhunt.awwo.local: state/ (the runtime's data folder), logs/ (the runtime's
    /// own log, its standard error, which holds no secret) and credentials-shown.
    let home: URL
    var state: URL { home.appendingPathComponent("state", isDirectory: true) }
    var logs: URL { home.appendingPathComponent("logs", isDirectory: true) }
    var credentialsShown: URL { home.appendingPathComponent("credentials-shown") }

    /// The payload's paths, or nil for an app built without one (the hosted service's client alone).
    static func inBundle() -> LocalPaths? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let payload = resources.appendingPathComponent("payload", isDirectory: true)
        let code = payload.appendingPathComponent("app", isDirectory: true)
        let build = payload.appendingPathComponent("build", isDirectory: true)
        let paths = LocalPaths(node: build.appendingPathComponent("node/bin/node"), script: code.appendingPathComponent("scripts/awwo-local.mjs"),
            code: code, build: build, home: FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/store.clawhunt.awwo.local", isDirectory: true))
        let files = FileManager.default
        return files.isExecutableFile(atPath: paths.node.path) && files.fileExists(atPath: paths.script.path) ? paths : nil
    }
}

/// What the runtime's ready event (scripts/awwo-local.mjs --events) must say for this window to open it: the data
/// folder's own address, which a browser opens (http, one name under .localhost, its port), and the window's (the same
/// port on 127.0.0.1, which the runtime answers only with this launch's cookie: macOS resolves *.localhost names only
/// from macOS 26 on), for this data folder.
private enum LocalReady {
    static func parse(_ event: [String: Any], state: URL) -> (browser: URL, window: URL)? {
        // Compared as paths: a file URL ends in "/" only where it was made for a folder (or found one on disk).
        guard event["event"] as? String == "ready",
            let browserValue = event["url"] as? String, let browser = URL(string: browserValue),
            let windowValue = event["window"] as? String, let window = URL(string: windowValue),
            let stateValue = event["stateDir"] as? String,
            URL(fileURLWithPath: stateValue).standardizedFileURL.path == state.standardizedFileURL.path else { return nil }
        guard browser.scheme == "http", let host = browser.host, isLocalhostName(host),
            let port = browser.port, (1...65535).contains(port), plainOrigin(browser) else { return nil }
        guard window.scheme == "http", window.host == "127.0.0.1", window.port == port, plainOrigin(window) else { return nil }
        return (browser, window)
    }
    /// An origin alone: no credentials, path, query or fragment.
    private static func plainOrigin(_ url: URL) -> Bool {
        url.user == nil && url.password == nil && (url.path.isEmpty || url.path == "/") && url.query == nil && url.fragment == nil
    }
    /// One name under .localhost, as the runtime names a data folder (awwo-<instance>.localhost, localOrigin in
    /// scripts/awwo-local-lib.mjs): lowercase letters, digits and inner hyphens, at most 63 of them.
    static func isLocalhostName(_ host: String) -> Bool {
        guard host.hasSuffix(".localhost") else { return false }
        let label = host.dropLast(".localhost".count)
        guard (1...63).contains(label.count), label.first != "-", label.last != "-" else { return false }
        return label.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}

/// The window's cookie (its launch's; the runtime keeps its sign-in) is for the host 127.0.0.1, which every port of it
/// shares, other accounts' servers too: a page of the app that loaded anything from another port of 127.0.0.1 while its
/// runtime runs would give that server the cookie, which is the window's way in, and with it the person's workspace. So
/// the window loads nothing from 127.0.0.1 but its own address: a WebKit
/// content rule list (block, then its own port let through). URLs are matched as WebKit writes them, the host's other
/// spellings (127.1, 2130706433) as 127.0.0.1; one with user information before the host (x@127.0.0.1) is blocked by a
/// rule of its own, and never let through. Rules have no alternation, and ^ and $ only at their ends.
private enum LoopbackRule {
    static func identifier(port: Int) -> String { "AwwOLocalLoopback\(port)" }
    static func json(port: Int) -> String {
        """
        [{"trigger":{"url-filter":"^[a-z]+://127\\\\.0\\\\.0\\\\.1[:/]"},"action":{"type":"block"}},\
        {"trigger":{"url-filter":"^[a-z]+://.*@127\\\\.0\\\\.0\\\\.1[:/]"},"action":{"type":"block"}},\
        {"trigger":{"url-filter":"^http://127\\\\.0\\\\.0\\\\.1:\(port)/"},"action":{"type":"ignore-previous-rules"}}]
        """
    }
}

/// This launch's token for the window's address (AWWO_LOCAL_SHELL_TOKEN, SHELL_TOKEN in scripts/awwo-local-lib.mjs):
/// given to the runtime in its environment, never on its command line, and set as the window's cookie in its own
/// WebKit store, which no browser has.
private enum ShellToken {
    static let environmentName = "AWWO_LOCAL_SHELL_TOKEN"
    static let cookieName = "awwo_shell"

    /// 32 random bytes as base64url without padding: 43 characters.
    static func make() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LaunchError("无法生成本机窗口的令牌。") }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func isValid(_ token: String) -> Bool {
        token.utf8.count == 43 && token.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
    }
    /// The window's cookie: for 127.0.0.1 alone (a host cookie), every path, for this session, unreadable by the page.
    static func cookie(_ token: String) -> HTTPCookie? {
        HTTPCookie(properties: [.name: cookieName, .value: token, .domain: "127.0.0.1", .path: "/",
            .discard: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
    }
}

/// What stopping a leftover database came to: none was running (or the data folder is not one a runtime made its own,
/// or a runtime holds it, whose own the database is), one was stopped, or one is still running after both a fast and an
/// immediate stop.
private enum LeftoverDatabase { case notRunning, stopped, stillRunning }

/// Stops the PostgreSQL a runtime that ended without stopping it left running (ended at the stop's deadline or from
/// outside, or crashed): pg_ctl starts the server outside the runtime's processes, so it outlives them. Only in a data
/// folder a runtime made its own (its local.env and the runtime.lock it made: a folder the runtime refused as
/// another's has neither of its own, and is never written to or stopped in), and with no runtime on it, whose lock
/// (runtime.lock, the flock a runtime takes) is held until the server has stopped. A fast stop (open sessions are
/// ended, the server checkpoints) is tried for a minute, then an immediate one.
private func stopLeftoverDatabase(_ paths: LocalPaths) -> LeftoverDatabase {
    let pgCtl = paths.build.appendingPathComponent("pgsql/bin/pg_ctl")
    let data = paths.state.appendingPathComponent("postgres", isDirectory: true)
    let files = FileManager.default
    guard files.isExecutableFile(atPath: pgCtl.path), files.fileExists(atPath: data.appendingPathComponent("postmaster.pid").path),
        files.fileExists(atPath: paths.state.appendingPathComponent("local.env").path) else { return .notRunning }
    let lock = open(paths.state.appendingPathComponent("runtime.lock").path, O_RDWR | O_EXLOCK | O_NONBLOCK | O_CLOEXEC)
    guard lock >= 0 else { return .notRunning }
    defer { close(lock) }
    func pgctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = pgCtl
        process.arguments = ["-D", data.path] + arguments
        process.environment = ["PATH": "/usr/bin:/bin", "LC_MESSAGES": "C"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }
    // pg_ctl status: 0 while the server runs, 3 when it does not.
    guard pgctl(["status"]) == 0 else { return .notRunning }
    if pgctl(["-m", "fast", "-w", "-t", "60", "stop"]) == 0 || pgctl(["status"]) == 3 { return .stopped }
    if pgctl(["-m", "immediate", "-w", "-t", "30", "stop"]) == 0 || pgctl(["status"]) == 3 { return .stopped }
    return .stillRunning
}

// A one-shot ownership record used only while stopping this app's runtime.
// Birth times come from the kernel (microsecond precision), not command strings.
private struct OwnedProcessIdentity {
    let pid: pid_t
    let parent: pid_t
    let group: pid_t
    let seconds: Int
    let microseconds: Int
    let zombie: Bool

    static func read(_ pid: pid_t) -> OwnedProcessIdentity? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&query, u_int(query.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return OwnedProcessIdentity(pid: pid, parent: info.kp_eproc.e_ppid, group: info.kp_eproc.e_pgid,
            seconds: info.kp_proc.p_starttime.tv_sec, microseconds: Int(info.kp_proc.p_starttime.tv_usec), zombie: info.kp_proc.p_stat == 5)
    }
    func matches(_ other: OwnedProcessIdentity?) -> Bool {
        guard let other else { return false }
        return pid == other.pid && seconds == other.seconds && microseconds == other.microseconds
    }
}

private struct StopProcessRow {
    let pid: pid_t
    let parent: pid_t
    let group: pid_t
    let identity: OwnedProcessIdentity?
}

private final class RuntimeStopOwnership {
    private let root: OwnedProcessIdentity
    private var owned: [pid_t: OwnedProcessIdentity]

    init(pid: pid_t) throws {
        // The runtime is this app's own child: a pid that another process has taken since (the runtime ended and was
        // reaped) is not taken for it.
        guard pid > 1, pid != getpid(), let root = OwnedProcessIdentity.read(pid), !root.zombie, root.parent == getpid() else {
            throw LaunchError("无法验证本次运行进程的身份，未执行强制清理。")
        }
        self.root = root
        self.owned = [pid: root]
        observe(try snapshot())
    }

    private func snapshot() throws -> [pid_t: StopProcessRow] {
        let inspection = Process()
        inspection.executableURL = URL(fileURLWithPath: "/bin/ps")
        inspection.arguments = ["-axo", "pid=,ppid=,pgid="]
        let pipe = Pipe()
        inspection.standardOutput = pipe
        inspection.standardError = FileHandle.nullDevice
        inspection.standardInput = FileHandle.nullDevice
        try inspection.run()
        let timeout = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timeout.schedule(deadline: .now() + 2)
        timeout.setEventHandler { if inspection.isRunning { inspection.terminate() } }
        timeout.resume()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        inspection.waitUntilExit()
        timeout.cancel()
        guard inspection.terminationStatus == 0, data.count < 2_000_000,
            let text = String(data: data, encoding: .utf8) else { throw LaunchError("无法读取进程归属，停止切换以避免误杀其他程序。") }
        var rows: [pid_t: StopProcessRow] = [:]
        for line in text.split(separator: "\n") {
            let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard fields.count == 3, let pid = Int32(fields[0]), let parent = Int32(fields[1]), let group = Int32(fields[2]) else {
                throw LaunchError("进程归属快照无效，未放行环境切换。")
            }
            let identity = OwnedProcessIdentity.read(pid)
            rows[pid] = StopProcessRow(pid: pid, parent: identity?.parent ?? parent,
                group: identity?.group ?? group, identity: identity)
        }
        for (pid, expected) in owned {
            if rows[pid]?.identity != nil { continue }
            if let current = OwnedProcessIdentity.read(pid) {
                if expected.matches(current), !current.zombie {
                    throw LaunchError("已知本机进程未完整出现在快照中，尚未放行退出。")
                }
            } else if kill(pid, 0) == 0 || errno != ESRCH {
                throw LaunchError("仍存活的本机进程无法读取身份，尚未放行退出。")
            }
        }
        return rows
    }

    private func observe(_ rows: [pid_t: StopProcessRow]) {
        var changed = true
        while changed {
            changed = false
            for row in rows.values {
                guard let identity = row.identity, !identity.zombie,
                    !identity.matches(owned[row.pid]), let parent = owned[row.parent],
                    parent.matches(rows[row.parent]?.identity) else { continue }
                owned[row.pid] = identity
                changed = true
            }
        }
    }

    private func living(_ rows: [pid_t: StopProcessRow], includeRoot: Bool) -> [StopProcessRow] {
        rows.values.filter { row in
            (includeRoot || row.pid != root.pid) && row.identity?.zombie == false && owned[row.pid]?.matches(row.identity) == true
        }
    }

    func hasSurvivors(includeRoot: Bool = false) throws -> Bool {
        let rows = try snapshot()
        observe(rows)
        return !living(rows, includeRoot: includeRoot).isEmpty
    }

    func detachedFixtureReady() throws -> Bool {
        let rows = try snapshot()
        observe(rows)
        let children = living(rows, includeRoot: false)
        return children.count >= 2 && Set(children.map(\.group)).count == 1
            && children.allSatisfy { $0.group > 1 && $0.group != root.group }
    }

    private func signalExact(_ identity: OwnedProcessIdentity, _ signal: Int32) throws {
        guard identity.matches(OwnedProcessIdentity.read(identity.pid)) else { return }
        if kill(identity.pid, signal) != 0 && errno != ESRCH { throw LaunchError("无法停止已验证的本机子进程，环境切换已取消。") }
    }

    private func signalChildren(_ signal: Int32) throws {
        let rows = try snapshot()
        observe(rows)
        let children = living(rows, includeRoot: false)
        var signalled = Set<pid_t>()
        for group in Set(children.map(\.group)) where group > 1 && group != getpgrp() && group != root.group {
            let members = rows.values.filter { $0.group == group && $0.identity?.zombie != true }
            // Never signal a group containing an unverified member. The exact-PID
            // fallback below handles owned children sharing another process's group.
            guard !members.isEmpty, members.allSatisfy({ row in
                guard row.pid != root.pid, let identity = row.identity, owned[row.pid]?.matches(identity) == true,
                    let current = OwnedProcessIdentity.read(row.pid) else { return false }
                return identity.matches(current) && current.group == group
            }) else { continue }
            if kill(-group, signal) != 0 && errno != ESRCH { throw LaunchError("本机进程组无法安全停止，环境切换已取消。") }
            signalled.formUnion(members.map(\.pid))
        }
        for row in children where !signalled.contains(row.pid) {
            if let identity = row.identity { try signalExact(identity, signal) }
        }
    }

    /// Ends a runtime that did not stop in time. Only the runtime itself is signalled: each wrapper it started ends its
    /// service, and that service's process group, once its pipe from the runtime closes (scripts/awwo-local-reaper.mjs),
    /// where a signal to the wrapper would end the service at once too. What of the processes it started is still
    /// there `childGrace` later (a process of its own group, as the managed execution's core) is ended by its exact
    /// identity. The database it started runs outside its processes and is stopped after (stopLeftoverDatabase).
    func forceCleanup(childGrace: TimeInterval = 10, killGrace: TimeInterval = 3) throws {
        observe(try snapshot())
        try signalExact(root, SIGKILL)
        let childDeadline = Date().addingTimeInterval(childGrace)
        while try hasSurvivors(includeRoot: true), Date() < childDeadline { usleep(50_000) }
        let killDeadline = Date().addingTimeInterval(killGrace)
        while try hasSurvivors(includeRoot: true), Date() < killDeadline {
            try signalChildren(SIGKILL)
            usleep(50_000)
        }
        guard try !hasSurvivors(includeRoot: true) else { throw LaunchError("仍有本机子进程未退出。请重试关闭。") }
    }
}

private enum NavigationPolicy {
    static let cloudURL: URL = {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "AwwOCloudURL") as? String,
            let url = URL(string: value), url.scheme == "https", url.host != nil,
            url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
            url.path.isEmpty || url.path == "/" else {
            fatalError("The signed AwwO bundle requires a valid production origin.")
        }
        return url
    }()
    static let accessHost = "lively-grass-61f6.cloudflareaccess.com"
    static let mainSiteHost = "clawhunt.store"
    static let mainSiteLoginURL = URL(string: "https://\(mainSiteHost)/login")!
    private static let mainSiteAuthPaths: Set<String> = [
        "/api/awwo/sso/authorize", "/api/awwo/sso/logout", "/login", "/register", "/account", "/awwo"
    ]

    static func port(_ url: URL) -> Int? {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil)
    }
    static func sameOrigin(_ candidate: URL?, _ origin: URL?, allowBlob: Bool = false) -> Bool {
        guard let candidate, let origin else { return false }
        if allowBlob && candidate.scheme == "blob" {
            return sameOrigin(URL(string: String(candidate.absoluteString.dropFirst(5))), origin)
        }
        return ["https", "http"].contains(candidate.scheme?.lowercased() ?? "")
            && candidate.scheme?.lowercased() == origin.scheme?.lowercased()
            && candidate.host?.lowercased() == origin.host?.lowercased()
            && port(candidate) == port(origin) && candidate.user == nil && candidate.password == nil
    }
    static func isAuthenticationURL(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https", url.host?.lowercased() == accessHost,
            port(url) == 443, url.user == nil, url.password == nil else { return false }
        let path = url.path
        return (path == "/cdn-cgi/access" || path.hasPrefix("/cdn-cgi/access/"))
            && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." })
    }
    static func isClawHuntSSOURL(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https", url.host?.lowercased() == mainSiteHost,
            port(url) == 443, url.user == nil, url.password == nil,
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath else { return false }
        // These are the only main-site documents needed for account handoff.
        // Compare the encoded path so dot segments or encoded slashes cannot
        // normalize into an allowlisted route.
        return mainSiteAuthPaths.contains(path)
    }
    static func isCloudNavigationURL(_ url: URL?) -> Bool {
        sameOrigin(url, cloudURL, allowBlob: true) || isAuthenticationURL(url) || isClawHuntSSOURL(url)
    }
    static func isClawHuntAuthorizationURL(_ url: URL?) -> Bool {
        guard isClawHuntSSOURL(url), let url, url.fragment == nil else { return false }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == "/api/awwo/sso/authorize"
    }
    static func frameMatches(protocol scheme: String, host: String, port framePort: Int, origin: URL?) -> Bool {
        guard let origin, !host.isEmpty, ["http", "https"].contains(scheme.lowercased()) else { return false }
        let actualPort = framePort == 0 ? (scheme.lowercased() == "https" ? 443 : 80) : framePort
        return scheme.lowercased() == origin.scheme?.lowercased() && host.lowercased() == origin.host?.lowercased()
            && actualPort == port(origin)
    }
    static func isEmbeddedPreview(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "about" && url.host == nil && url.query == nil && ["srcdoc", "blank"].contains(url.path)
    }
}

private enum NavigationHTTPFailure {
    static func offersMainSiteLogin(_ response: HTTPURLResponse, cloud: Bool) -> Bool {
        cloud && response.statusCode == 403 && NavigationPolicy.isClawHuntAuthorizationURL(response.url)
    }

    // A Ray is diagnostic context, not proof that Cloudflare caused the denial.
    // Never reflect arbitrary response text, cookies, or authorization URLs.
    private static func cloudflareRayID(_ response: HTTPURLResponse) -> String? {
        guard let raw = response.value(forHTTPHeaderField: "cf-ray"),
            raw.utf8.count == 16 || raw.utf8.count == 20 else { return nil }
        let bytes = Array(raw.utf8)
        guard bytes.prefix(16).allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
            bytes.count == 16 || (bytes[16] == 45 && bytes.suffix(3).allSatisfy({ (65...90).contains($0) })) else { return nil }
        return String(raw.prefix(20))
    }

    static func detail(_ response: HTTPURLResponse, cloud: Bool) -> String {
        if response.statusCode == 403 {
            let denied = "服务器拒绝了此请求（HTTP 403）。请联系支持人员核查账号权限与访问规则。"
            guard cloud, let ray = cloudflareRayID(response) else { return denied }
            return denied + "\nCloudflare 请求编号：\(ray)"
        }
        return "服务器返回 HTTP \(response.statusCode)。请重新载入；线上访问需完成 Cloudflare Access 和 AwwO 账号登录。"
    }
}

// The deadline belongs to one provisional main-document navigation. didFinish
// also waits for subresources, so it must not be the document-readiness signal.
private final class NavigationLoadMonitor {
    private var navigation: AnyObject?
    private var committed = false
    private var timer: Timer?
    private(set) var hasCommittedDocument = false

    func start(_ navigation: AnyObject, timeout: TimeInterval, onTimeout: @escaping (Bool) -> Void) {
        cancelTimer()
        self.navigation = navigation
        committed = false
        timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
            guard let self, self.navigation === navigation, !self.committed else { return }
            self.cancel(navigation)
            onTimeout(self.hasCommittedDocument)
        }
    }

    @discardableResult func commit(_ navigation: AnyObject) -> Bool {
        guard self.navigation === navigation else { return false }
        committed = true
        hasCommittedDocument = true
        cancelTimer()
        return true
    }

    @discardableResult func finish(_ navigation: AnyObject) -> Bool {
        guard commit(navigation) else { return false }
        self.navigation = nil
        return true
    }

    @discardableResult func cancel(_ navigation: AnyObject) -> Bool {
        guard self.navigation === navigation else { return false }
        cancelTimer()
        self.navigation = nil
        return true
    }

    func prepareForNavigation() {
        cancelTimer()
        navigation = nil
        committed = false
    }

    func reset() {
        prepareForNavigation()
        hasCommittedDocument = false
    }

    private func cancelTimer() {
        timer?.invalidate()
        timer = nil
    }
}

// AppDelegate owns this window. AppKit must not release it again on close:
// the termination and reopen callbacks still access its sheets and content.
private func makeWorkspaceWindow() -> NSWindow {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = "AwwO"
    window.minSize = NSSize(width: 980, height: 680)
    window.titlebarAppearsTransparent = true
    window.backgroundColor = .windowBackgroundColor
    return window
}

// Cloud and local workspaces have separate cookies and lifecycles. Cloud pages
// never receive a script bridge or start/access the bundled local runtime.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, NSMenuItemValidation {
    private let bundleID = "store.clawhunt.awwo.local"
    /// The local edition's files, where this build carries them (AWWO_MAC_LOCAL_PAYLOAD in build.ts); nil in a build of
    /// the hosted service's client alone, which never offers the local workspace.
    private let localPaths = LocalPaths.inBundle()
    private var supportsLocalWorkspace: Bool { localPaths != nil }
    /// The workspace last opened, opened again at the next launch; none chosen yet, the window asks.
    private let modeDefault = "AwwOWorkspaceMode"
    private let cloudURL = NavigationPolicy.cloudURL
    private let cloudDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "C4B6F31C-57B1-49F0-873B-DA03351FAE72")!)
    /// The local workspace's own store: its window's cookie (the runtime keeps its sign-in) and the page's own data,
    /// apart from the cloud's and from what an earlier build's local mode left in the default store.
    private let localDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "5D3A8C21-7F4E-4B9A-A6E2-1C0F9B7D3E58")!)
    private var mode: WorkspaceMode = .cloud
    private var generation = UUID()
    private var pendingMode: WorkspaceMode?
    /// A restart of the local workspace asked during a stop, and whether it resets the sign-in password.
    private var pendingReset = false
    private var switching = false
    private var choosing = false
    private var pageLoadFailed = false
    private let pageLoad = NavigationLoadMonitor()
    private let outputQueue = DispatchQueue(label: "store.clawhunt.awwo.local.runtime-output")
    private var runtime: Process?
    private var outputPipe: Pipe?
    /// The runtime's standard input: closing it is its stop in order (--stop-on-stdin-close).
    private var runtimeInput: Pipe?
    private var logHandle: FileHandle?
    private var shutdownTimer: Timer?
    private var stopOwnership: RuntimeStopOwnership?
    private var forcedCleanupRunning = false
    private var cleanupNeedsAttention = false
    /// A runtime has ended and the database it may have left is being stopped: what follows waits for it.
    private var cleaning = false
    private var pendingExitStatus: Int32?
    private var terminating = false
    private var terminationReplied = false
    private var runtimeFailed = false
    /// The error the runtime last reported: what its end is shown with, when it stops by itself.
    private var runtimeError: String?
    /// This launch's token (ShellToken), the window's address (127.0.0.1) and the browser's (the data folder's name).
    private var shellToken: String?
    private var localURL: URL?
    private var browserURL: URL?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: NSView!
    private var statusHeading: NSTextField!
    private var statusDetail: NSTextField!
    private var spinner: NSProgressIndicator!
    private var loginRecoveryActions: NSStackView!
    private var workspaceChoices: NSStackView!
    private var retryButton: NSButton!
    private var mainSiteLoginAvailable = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }) {
            existing.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }
        makeMenu()
        makeWindow()
        // The workspace last opened; a build with the local edition asks once which to open, one without it has the
        // cloud alone.
        switch UserDefaults.standard.string(forKey: modeDefault).flatMap(WorkspaceMode.init(rawValue:)) {
        case .some(.local) where supportsLocalWorkspace: beginWorkspace(.local)
        case .some(.cloud): beginWorkspace(.cloud)
        default: if supportsLocalWorkspace { offerWorkspaces() } else { beginWorkspace(.cloud) }
        }
    }

    /// The first launch of a build with the local edition: which workspace to open (the menu 工作区 switches later).
    private func offerWorkspaces() {
        choosing = true
        window.title = "AwwO"
        statusView.isHidden = false
        spinner.stopAnimation(nil)
        retryButton.isHidden = true
        loginRecoveryActions.isHidden = true
        workspaceChoices.isHidden = false
        statusHeading.stringValue = "选择工作区"
        statusDetail.stringValue = "线上工作区使用你的 AwwO 账号，与网站同步。本机工作区（AwwO 本地版）在这台 Mac 上运行，账号、画布和记录只保存在这里，模型使用你自己的 Key。之后可从菜单「工作区」切换。"
    }
    @objc private func chooseCloud() { chooseWorkspace(.cloud) }
    @objc private func chooseLocal() { chooseWorkspace(.local) }
    private func chooseWorkspace(_ selected: WorkspaceMode) {
        guard choosing, !terminating, selected == .cloud || supportsLocalWorkspace else { return }
        choosing = false
        workspaceChoices.isHidden = true
        retryButton.isHidden = false
        beginWorkspace(selected)
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu(title: "AwwO")
        appItem.submenu = appMenu
        addItem("关于 AwwO", action: #selector(showAbout), to: appMenu)
        appMenu.addItem(.separator())
        if supportsLocalWorkspace {
            // The local workspace's menu, named as AwwO Local's on Windows (apps/windows-local), which the app's own
            // pages name where a checkout's person would run an npm command (--shell macos).
            addItem("重新启动 Restart", action: #selector(restartLocal), to: appMenu)
            addItem("在浏览器中打开 Open in browser", action: #selector(openLocalInBrowser), to: appMenu)
            appMenu.addItem(.separator())
            addItem("打开数据目录 Open the data folder", action: #selector(openDataDirectory), to: appMenu)
            addItem("打开日志 Open the logs", action: #selector(openLog), to: appMenu)
            appMenu.addItem(.separator())
            addItem("重置登录密码（重新启动） Reset the sign-in password (restarts)", action: #selector(resetLocalPassword), to: appMenu)
            appMenu.addItem(.separator())
        }
        addItem("隐藏 AwwO", action: #selector(NSApplication.hide(_:)), key: "h", to: appMenu, target: NSApp)
        addItem("退出 AwwO", action: #selector(NSApplication.terminate(_:)), key: "q", to: appMenu, target: NSApp)

        let editMenu = NSMenu(title: "编辑")
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        // A nil target preserves AppKit's first-responder chain inside WKWebView.
        let edits: [(String, String, String)] = [
            ("撤销", "undo:", "z"), ("重做", "redo:", "Z"),
            ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
            ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")
        ]
        for (title, selector, key) in edits {
            editMenu.addItem(NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key))
        }

        let viewMenu = NSMenu(title: "显示")
        let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: "")
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        addItem("返回", action: #selector(goBack), key: "[", to: viewMenu)
        addItem("前进", action: #selector(goForward), key: "]", to: viewMenu)
        addItem("工作区首页", action: #selector(openWorkspaceHome), key: "H", to: viewMenu)
        viewMenu.addItem(.separator())
        addItem("刷新", action: #selector(reloadPage), key: "r", to: viewMenu)
        addItem("在默认浏览器中打开", action: #selector(openInBrowser), to: viewMenu)

        if supportsLocalWorkspace {
            let workspaceMenu = NSMenu(title: "工作区")
            let workspaceItem = NSMenuItem(title: "工作区", action: nil, keyEquivalent: "")
            workspaceItem.submenu = workspaceMenu
            menu.addItem(workspaceItem)
            addItem("线上工作区 AwwO Cloud", action: #selector(switchToCloud), to: workspaceMenu)
            addItem("本机工作区 AwwO 本地版", action: #selector(switchToLocal), to: workspaceMenu)
        }
        NSApp.mainMenu = menu
    }

    private func addItem(_ title: String, action: Selector, key: String = "", to menu: NSMenu, target: AnyObject? = nil) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = target ?? self
        menu.addItem(item)
    }

    private func makeWindow() {
        window = makeWorkspaceWindow()
        window.delegate = self
        window.center()

        let content = NSView()
        window.contentView = content

        statusView = NSView()
        statusView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusView)
        NSLayoutConstraint.activate([
            statusView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            statusView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            statusView.topAnchor.constraint(equalTo: content.topAnchor),
            statusView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        statusHeading = NSTextField(labelWithString: "正在打开工作区")
        statusHeading.font = .systemFont(ofSize: 25, weight: .semibold)
        statusHeading.alignment = .center
        statusDetail = NSTextField(wrappingLabelWithString: "使用现有线上账号，访问同一份工作区与历史记录。")
        statusDetail.alignment = .center
        statusDetail.textColor = .secondaryLabelColor
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        retryButton = NSButton(title: "重新载入", target: self, action: #selector(reloadPage))
        loginRecoveryActions = NSStackView(views: [
            NSButton(title: "登录主站", target: self, action: #selector(openMainSiteLogin)),
            NSButton(title: "返回 AwwO 首页", target: self, action: #selector(openWorkspaceHome))
        ])
        loginRecoveryActions.spacing = 12
        loginRecoveryActions.isHidden = true
        workspaceChoices = NSStackView(views: [
            NSButton(title: "线上工作区", target: self, action: #selector(chooseCloud)),
            NSButton(title: "本机工作区（AwwO 本地版）", target: self, action: #selector(chooseLocal))
        ])
        workspaceChoices.spacing = 12
        workspaceChoices.isHidden = true
        let stack = NSStackView(views: [spinner, statusHeading, statusDetail, loginRecoveryActions, workspaceChoices, retryButton])
        stack.orientation = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        statusView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: statusView.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 600)
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWebView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = mode == .cloud ? cloudDataStore : localDataStore
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        if mode == .local {
            configuration.userContentController.add(self, name: "localDiagnostics")
            configuration.userContentController.addUserScript(WKUserScript(source: """
                (() => {
                  const report = (kind, value) => {
                    try { window.webkit.messageHandlers.localDiagnostics.postMessage({kind, message: String(value).slice(0, 512)}); } catch (_) {}
                  };
                  window.addEventListener('error', e => report('error', e.message));
                  window.addEventListener('unhandledrejection', e => report('unhandledrejection', e.reason && e.reason.message || 'Promise rejected'));
                })();
                """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        let content = window.contentView!
        content.addSubview(webView, positioned: .below, relativeTo: statusView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
    }

    /// Takes the page down, and with it the local workspace's addresses: they were its runtime's, whose port is anyone's
    /// once that runtime stops (retireLocalPage), so no later action loads one again in a new page (beginWorkspace sets
    /// them when the next runtime is ready).
    private func removeWebView() {
        localURL = nil
        browserURL = nil
        pageLoad.reset()
        for sheet in window?.sheets ?? [] { window?.endSheet(sheet, returnCode: .cancel) }
        for download in downloads.values { download.cancel { _ in } }
        downloads.removeAll()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "localDiagnostics")
        webView?.removeFromSuperview()
        webView = nil
    }

    private func beginWorkspace(_ selected: WorkspaceMode, resetPassword: Bool = false) {
        guard selected == .cloud || supportsLocalWorkspace else { return }
        mode = selected
        UserDefaults.standard.set(selected.rawValue, forKey: modeDefault)
        switching = false
        pendingMode = nil
        pendingReset = false
        runtimeFailed = false
        runtimeError = nil
        pageLoadFailed = false
        localURL = nil
        browserURL = nil
        window.title = selected == .cloud ? "AwwO" : "AwwO · 本机工作区（独立数据）"
        makeWebView()
        statusView.isHidden = false
        spinner.startAnimation(nil)
        if selected == .cloud {
            try? logHandle?.close()
            logHandle = nil
            statusHeading.stringValue = "正在打开工作区"
            statusDetail.stringValue = "awwo.clawhunt.store · 使用现有线上账号与历史记录。"
            loadPage(cloudURL)
        } else {
            statusHeading.stringValue = "正在启动 AwwO 本地版"
            statusDetail.stringValue = "本机账号与数据独立保存，不同步线上工作区。第一次启动要建立数据库，可能需要几分钟。"
            startRuntime(resetPassword: resetPassword)
        }
    }

    @objc private func switchToCloud() { switchWorkspace(.cloud) }
    @objc private func switchToLocal() { switchWorkspace(.local) }
    private func switchWorkspace(_ selected: WorkspaceMode, resetPassword: Bool = false) {
        if choosing { chooseWorkspace(selected); return }
        // Another workspace, or the local one again (a restart).
        guard !terminating, !switching, !cleaning, selected != mode || selected == .local,
            selected == .cloud || supportsLocalWorkspace else { return }
        generation = UUID()
        switching = true
        pendingMode = selected
        pendingReset = resetPassword
        removeWebView()
        statusView.isHidden = false
        spinner.startAnimation(nil)
        if let process = runtime {
            statusHeading.stringValue = selected == .local ? "正在重新启动 AwwO 本地版" : "正在关闭本机服务"
            statusDetail.stringValue = "AwwO 本地版正在有序停止：先停 API，再停执行服务和数据库（最多几分钟）。"
            // One that has exited already has its end on its way (runtimeExited, queued): that stops what it left
            // running, then opens the workspace asked for (pendingMode).
            if process.isRunning || cleanupNeedsAttention || stopOwnership != nil { stopRuntime(process) }
        } else {
            beginWorkspace(selected, resetPassword: resetPassword)
        }
    }

    /// Stops the local workspace's runtime in order and starts it again (menu 重新启动); with a new sign-in password
    /// (重置登录密码), whose admin-credentials.txt opens once it is ready.
    @objc private func restartLocal() { if mode == .local { switchWorkspace(.local) } }
    @objc private func resetLocalPassword() {
        guard mode == .local, let paths = localPaths else { return }
        try? FileManager.default.removeItem(at: paths.credentialsShown)
        switchWorkspace(.local, resetPassword: true)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if choosing { return [#selector(switchToCloud), #selector(switchToLocal), #selector(showAbout)].contains(menuItem.action) }
        if menuItem.action == #selector(switchToCloud) {
            menuItem.state = mode == .cloud ? .on : .off
            return !switching && !terminating && !cleaning && mode != .cloud
        }
        if menuItem.action == #selector(switchToLocal) {
            menuItem.state = mode == .local ? .on : .off
            return supportsLocalWorkspace && !switching && !terminating && !cleaning && mode != .local
        }
        if [#selector(restartLocal), #selector(resetLocalPassword)].contains(menuItem.action) {
            return mode == .local && !switching && !terminating && !cleaning
        }
        if [#selector(openDataDirectory), #selector(openLog)].contains(menuItem.action) {
            return supportsLocalWorkspace && !terminating
        }
        if menuItem.action == #selector(openLocalInBrowser) {
            return mode == .local && browserURL != nil && !switching && !terminating
        }
        if menuItem.action == #selector(goBack) { return !switching && !terminating && webView?.canGoBack == true }
        if menuItem.action == #selector(goForward) { return !switching && !terminating && webView?.canGoForward == true }
        if menuItem.action == #selector(reloadPage) { return !switching && !terminating && !cleaning && !forcedCleanupRunning }
        if [#selector(openInBrowser), #selector(openWorkspaceHome)].contains(menuItem.action) { return !switching && !terminating }
        return true
    }

    private func loadPage(_ url: URL) {
        clearLoginRecovery()
        pageLoadFailed = false
        pageLoad.prepareForNavigation()
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45))
    }

    /// Starts the local edition's runtime (scripts/awwo-local.mjs) from the payload, with this account's data folder:
    /// one JSON event a line on its standard output, its log on its standard error (the shell's logs folder, which holds
    /// no secret), and its stop in order when its standard input closes. Its own deadlines bound its start (the API's
    /// five minutes, a first start's initdb): no timer of the window's cuts a slow first start short.
    private func startRuntime(resetPassword: Bool = false) {
        guard let paths = localPaths, mode == .local, !switching, !terminating else { return }
        let launchGeneration = generation
        do {
            let files = FileManager.default
            try files.createDirectory(at: paths.logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.home.path)
            let logURL = paths.logs.appendingPathComponent("runtime.log")
            if !files.fileExists(atPath: logURL.path) { files.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            try? logHandle?.close()
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()
            log("Launching AwwO 本地版 from \(paths.code.path)")
            let token = try ShellToken.make()
            let process = Process()
            process.executableURL = paths.node
            process.arguments = [paths.script.path, "--events", "--stop-on-stdin-close", "--shell", "macos",
                "--parent-pid", String(ProcessInfo.processInfo.processIdentifier),
                "--resources", paths.code.path, "--build", paths.build.path, "--state", paths.state.path] + (resetPassword ? ["--reset-password"] : [])
            process.currentDirectoryURL = paths.code
            // Finder and shell launches start it alike: none of the person's Node.js or AwwO settings reach it (they
            // could load code or name another PostgreSQL). The system's folders come first on PATH, then Homebrew's,
            // where ffmpeg and ffprobe usually are (renders); a proxy set in a shell is passed on.
            let inherited = ProcessInfo.processInfo.environment
            var environment = [
                "HOME": files.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
                "TMPDIR": NSTemporaryDirectory(),
                "LANG": inherited["LANG"] ?? "en_US.UTF-8",
                ShellToken.environmentName: token
            ]
            for name in ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"] {
                if let value = inherited[name] { environment[name] = value }
            }
            process.environment = environment
            let output = Pipe()
            let input = Pipe()
            let buffer = RuntimeOutputBuffer()
            outputPipe = output
            runtimeInput = input
            process.standardOutput = output
            process.standardError = logHandle
            process.standardInput = input
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                self?.outputQueue.async { [weak self] in self?.consumeOutput(data, buffer: buffer, generation: launchGeneration) }
            }
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async { self?.runtimeExited(process, status: process.terminationStatus) }
            }
            shellToken = token
            runtime = process
            try process.run()
            // The child has its own copy of the pipe's read end; this process keeps only the write end.
            try? input.fileHandleForReading.close()
        } catch {
            // Not started, so no end of it will come (its terminationHandler): nothing of it is left to wait for.
            outputPipe?.fileHandleForReading.readabilityHandler = nil
            outputPipe = nil
            runtimeInput = nil
            runtime = nil
            shellToken = nil
            fail("无法启动 AwwO 本地版", detail: error.localizedDescription)
        }
    }

    private func consumeOutput(_ data: Data, buffer: RuntimeOutputBuffer, generation: UUID) {
        buffer.data.append(data)
        while let newline = buffer.data.firstIndex(of: 10) {
            let line = Data(buffer.data[..<newline])
            buffer.data.removeSubrange(...newline)
            guard line.count <= 65_536,
                let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            DispatchQueue.main.async { [weak self] in self?.receiveRuntimeEvent(object, generation: generation) }
        }
        // An unexpected non-line-based dependency must not exhaust native memory.
        if buffer.data.count > 1_048_576 { buffer.data.removeAll(keepingCapacity: false) }
    }

    private func receiveRuntimeEvent(_ event: [String: Any], generation: UUID) {
        guard !terminating, !switching, mode == .local, self.generation == generation, let paths = localPaths else { return }
        switch event["event"] as? String ?? "" {
        case "status":
            // The runtime's steps (scripts/awwo-local.mjs): database, workers, api.
            let steps = ["database": "正在启动数据库…", "workers": "正在启动执行服务…", "api": "正在启动 API…"]
            if localURL == nil, !runtimeFailed, let step = event["step"] as? String, let text = steps[step] { statusDetail.stringValue = text }
        case "error":
            // The runtime is stopping in order on its own (its error ends it): a signal now would cut that stop short.
            runtimeFailed = true
            let message = event["message"] as? String ?? "请查看日志。"
            runtimeError = message
            retireLocalPage()
            fail("AwwO 本地版遇到错误，正在停止", detail: message)
        case "stopping":
            // Its stop has begun, which it says as it begins (its web server then answers 503 alone until it ends): from
            // outside (a signal), at its parent's end, or after its error (said above). The window's own stops ignore it
            // (switching, terminating).
            retireLocalPage()
        case "ready":
            guard !runtimeFailed, localURL == nil else { return }
            guard let ready = LocalReady.parse(event, state: paths.state), let token = shellToken, let cookie = ShellToken.cookie(token) else {
                runtimeFailed = true
                runtimeError = "AwwO 本地版报告了意外的地址（\(event["url"] as? String ?? "")），这个窗口只打开本应用启动的本机服务。"
                fail("AwwO 本地版报告了意外的地址", detail: "仅打开本应用启动的本机服务。请用菜单「AwwO → 打开日志」查看日志。")
                if let process = runtime, process.isRunning { stopRuntime(process) }
                return
            }
            localURL = ready.window
            browserURL = ready.browser
            log("Runtime ready: \(ready.browser.absoluteString) (window \(ready.window.absoluteString))")
            statusDetail.stringValue = "AwwO 本地版已就绪，正在载入工作台。"
            let current = { [weak self] () -> Bool in
                guard let self else { return false }
                return self.generation == generation && self.mode == .local && !self.switching && !self.terminating && self.localURL == ready.window
            }
            // Before its first request: the rule that keeps its cookies at its own port, then the window's cookie (the
            // runtime answers its address only with it).
            let port = ready.window.port ?? 0
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: LoopbackRule.identifier(port: port),
                encodedContentRuleList: LoopbackRule.json(port: port)) { [weak self] list, error in
                DispatchQueue.main.async {
                    guard let self, current() else { return }
                    guard let list, error == nil, let webView = self.webView else {
                        self.runtimeFailed = true
                        self.runtimeError = "无法为本机窗口设置网络规则：\(error?.localizedDescription ?? "WebKit 没有给出规则")"
                        self.fail("AwwO 本地版无法打开", detail: self.runtimeError ?? "")
                        if let process = self.runtime, process.isRunning { self.stopRuntime(process) }
                        return
                    }
                    webView.configuration.userContentController.add(list)
                    self.localDataStore.httpCookieStore.setCookie(cookie) {
                        guard current() else { return }
                        self.loadPage(ready.window)
                        self.showCredentialsOnce(host: ready.browser.host ?? "", paths: paths)
                    }
                }
            }
        default:
            break
        }
    }

    /// The sign-in file opens the first time a data folder is ready (it has a name of its own, the address's host), and
    /// after a password reset (which removes the mark): a start that failed before it was ready leaves it for the next.
    private func showCredentialsOnce(host: String, paths: LocalPaths) {
        let shown = (try? String(contentsOf: paths.credentialsShown, encoding: .utf8)) ?? ""
        guard shown != host else { return }
        let credentials = paths.state.appendingPathComponent("admin-credentials.txt")
        guard FileManager.default.fileExists(atPath: credentials.path) else { return }
        NSWorkspace.shared.open([credentials], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
            configuration: NSWorkspace.OpenConfiguration())
        try? host.write(to: paths.credentialsShown, atomically: true, encoding: .utf8)
    }

    /// Takes the local workspace's page down once its runtime is stopping (its stopping event, however its stop came) or
    /// has gone. Once it has ended its port is free for any program on this computer to take, another account's
    /// included, and the page's requests (its polls, a run's event stream) would carry the window's cookie, the host
    /// 127.0.0.1's, to whatever listens there next: that launch's token alone, which opens nothing by then (the runtime
    /// keeps the window's sign-in), so this is one more layer. A stop the window asks for takes the page down first itself
    /// (switchWorkspace, applicationShouldTerminate); the next start makes a new one (beginWorkspace).
    private func retireLocalPage() {
        guard mode == .local, webView != nil else { return }
        removeWebView()
        // A failure already said (runtimeFailed: its error, an unexpected address; cleanupNeedsAttention: a stop that
        // could not end it, whose 重新载入 retries it) stays what the window says.
        guard !runtimeFailed, !cleanupNeedsAttention else { return }
        statusView.isHidden = false
        spinner.startAnimation(nil)
        statusHeading.stringValue = "AwwO 本地版正在停止"
        statusDetail.stringValue = "停完后可以用菜单「AwwO → 重新启动」再启动。"
    }

    private func runtimeExited(_ process: Process, status: Int32) {
        guard runtime === process else { return }
        retireLocalPage()
        pendingExitStatus = status
        if forcedCleanupRunning || cleanupNeedsAttention { return }
        if let ownership = stopOwnership {
            do {
                if try ownership.hasSurvivors() { forceCleanup(process, ownership: ownership); return }
            } catch { cleanupFailed(error); return }
        }
        completeRuntimeExit(process, status: status)
    }

    private func completeRuntimeExit(_ process: Process, status: Int32) {
        guard runtime === process else { return }
        shutdownTimer?.invalidate()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        try? runtimeInput?.fileHandleForWriting.close()
        runtimeInput = nil
        runtime = nil
        stopOwnership = nil
        cleanupNeedsAttention = false
        pendingExitStatus = nil
        shellToken = nil
        localURL = nil
        browserURL = nil
        log("Runtime exited with status \(status)")
        // A runtime that was ended (at the stop's deadline, or from outside) or crashed leaves its database running; one
        // that stopped in order leaves none, and this only asks. Before anything follows, off the main thread (pg_ctl
        // may take a minute), with what is asked meanwhile waiting for it.
        cleaning = true
        let paths = localPaths
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let leftover = paths.map(stopLeftoverDatabase) ?? .notRunning
            DispatchQueue.main.async {
                guard let self else { return }
                self.cleaning = false
                switch leftover {
                case .stopped: self.log("Stopped the database the runtime left running")
                case .stillRunning: self.log("The database the runtime left running did not stop (pg_ctl fast, then immediate)")
                case .notRunning: break
                }
                // A database still running is said: the next start waits for it and stops it, but until then it runs.
                // Said before a quit or a switch to the cloud workspace too; a start of the local one stops it itself,
                // and says so if it cannot.
                let still = leftover == .stillRunning
                    ? "\n\n它留下的数据库没能停止，仍在运行：下次启动 AwwO 本地版时会先停止它。也可以在「活动监视器」中结束 postgres。" : ""
                if self.terminating {
                    if leftover == .stillRunning { self.reportDatabaseStillRunning() }
                    self.finishTermination()
                } else if let next = self.pendingMode {
                    if leftover == .stillRunning, next == .cloud { self.reportDatabaseStillRunning() }
                    self.beginWorkspace(next, resetPassword: self.pendingReset)
                } else {
                    let why = self.runtimeError.map { "\($0)\n\n" } ?? ""
                    self.fail("AwwO 本地版已停止（\(status)）", detail: "\(why)用菜单「AwwO → 重新启动」再启动；「AwwO → 打开日志」里有它的日志。\(still)")
                }
            }
        }
    }

    /// Says, before the window quits or opens the cloud workspace, that the database a runtime left running did not stop
    /// (a fast, then an immediate stop): it runs on until the next start of AwwO 本地版, which stops it first.
    private func reportDatabaseStillRunning() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "AwwO 本地版的数据库没能停止"
        alert.informativeText = "它仍在运行：下次启动 AwwO 本地版时会先停止它。也可以在「活动监视器」中结束 postgres。"
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    private func finishTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        shutdownTimer?.invalidate()
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    private func clearLoginRecovery() {
        mainSiteLoginAvailable = false
        loginRecoveryActions?.isHidden = true
    }

    private func fail(_ title: String, detail: String, offerMainSiteLogin: Bool = false) {
        guard window != nil else { return }
        clearLoginRecovery()
        mainSiteLoginAvailable = offerMainSiteLogin && mode == .cloud
        loginRecoveryActions.isHidden = !mainSiteLoginAvailable
        pageLoadFailed = true
        pageLoad.reset()
        // Online authentication URLs may carry tokens. Never record their errors
        // or page content in local runtime logs.
        if mode == .local { log("\(title): \(detail)") }
        webView?.stopLoading()
        webView?.isHidden = true
        statusView.isHidden = false
        spinner.stopAnimation(nil)
        statusHeading.stringValue = title
        let guidance = mainSiteLoginAvailable
            ? "\n\n可先在此应用内登录主站。登录后选择“显示 → 工作区首页”，再点击“使用 ClawHunt 账号继续”重新开始。若仍被拒绝，请联系支持，并附上请求编号（如有）。"
            : ""
        statusDetail.stringValue = String(detail.prefix(1500)) + guidance
    }

    private func log(_ message: String) {
        let line = "[native \(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        if let data = line.data(using: .utf8) { try? logHandle?.write(contentsOf: data) }
    }

    private func isLocal(_ url: URL?) -> Bool {
        mode == .local && NavigationPolicy.sameOrigin(url, localURL, allowBlob: true)
    }

    private func isLocal(_ frame: WKFrameInfo) -> Bool {
        guard mode == .local else { return false }
        let securityOrigin = frame.securityOrigin
        return NavigationPolicy.frameMatches(protocol: securityOrigin.protocol, host: securityOrigin.host,
            port: securityOrigin.port, origin: localURL)
    }

    private func isApplicationURL(_ url: URL?) -> Bool {
        NavigationPolicy.sameOrigin(url, mode == .cloud ? cloudURL : localURL, allowBlob: true)
    }

    private func isApplicationFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return NavigationPolicy.frameMatches(protocol: origin.protocol, host: origin.host,
            port: origin.port, origin: mode == .cloud ? cloudURL : localURL)
    }

    private func isAllowedNavigation(_ url: URL?) -> Bool {
        mode == .cloud ? NavigationPolicy.isCloudNavigationURL(url) : isApplicationURL(url)
    }

    private func isEmbeddedPreview(_ url: URL?) -> Bool {
        // sandboxed srcDoc documents have an opaque origin. This exception is
        // only for rendering; native privileges still require the application origin.
        return NavigationPolicy.isEmbeddedPreview(url)
    }

    private func openExternal(_ url: URL) {
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView, !switching, !terminating,
            let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == false,
            isApplicationURL(webView.url), isEmbeddedPreview(url) {
            decisionHandler(navigationAction.shouldPerformDownload ? .cancel : .allow)
            return
        }
        if isAllowedNavigation(url) {
            if navigationAction.shouldPerformDownload {
                decisionHandler(isApplicationURL(url) && isApplicationFrame(navigationAction.sourceFrame) ? .download : .cancel)
            }
            else { decisionHandler(.allow) }
            return
        }
        if navigationAction.targetFrame?.isMainFrame != false && navigationAction.navigationType == .linkActivated {
            openExternal(url)
        } else if navigationAction.targetFrame?.isMainFrame == true && mode == .cloud {
            fail("线上页面跳转被阻止", detail: "该地址不在已核实的线上或登录域名范围内。可从“显示”菜单在默认浏览器打开线上工作区。")
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard webView === self.webView, !switching, !terminating else { decisionHandler(.cancel); return }
        if !navigationResponse.isForMainFrame, isApplicationURL(webView.url),
            isEmbeddedPreview(navigationResponse.response.url) {
            decisionHandler(.allow)
            return
        }
        guard isAllowedNavigation(navigationResponse.response.url) else { decisionHandler(.cancel); return }
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            fail(mode == .cloud ? "线上页面暂时无法访问" : "本机页面暂时无法访问",
                detail: NavigationHTTPFailure.detail(response, cloud: mode == .cloud),
                offerMainSiteLogin: NavigationHTTPFailure.offersMainSiteLogin(response, cloud: mode == .cloud))
            decisionHandler(.cancel)
            return
        }
        let attachment = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        if !navigationResponse.canShowMIMEType || attachment {
            decisionHandler(isApplicationURL(navigationResponse.response.url) && isApplicationURL(webView.url) ? .download : .cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard webView === self.webView, !switching, !terminating,
            (isApplicationFrame(navigationAction.sourceFrame) || (mode == .cloud &&
                (NavigationPolicy.isAuthenticationURL(navigationAction.sourceFrame.request.url) || NavigationPolicy.isClawHuntSSOURL(navigationAction.sourceFrame.request.url)))),
            let url = navigationAction.request.url else { return nil }
        if isAllowedNavigation(url) {
            pageLoad.prepareForNavigation()
            webView.load(navigationAction.request)
        } else { openExternal(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView, let navigation, !switching, !terminating else { return }
        clearLoginRecovery()
        pageLoadFailed = false
        let pageGeneration = generation
        pageLoad.start(navigation, timeout: 60) { [weak self, weak webView] hasDocument in
            guard let self, let webView, self.generation == pageGeneration,
                webView === self.webView, !self.switching, !self.terminating else { return }
            if hasDocument {
                // A stalled next navigation must not replace an existing canvas.
                webView.stopLoading()
                self.showCommittedPage(webView)
            } else {
                self.fail("页面加载超时", detail: "请检查网络连接后重新载入。线上工作区需要通过登录验证。")
            }
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === self.webView, let navigation, !switching, !terminating,
            pageLoad.commit(navigation) else { return }
        showCommittedPage(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, let navigation, !switching, !terminating,
            pageLoad.finish(navigation) else { return }
        showCommittedPage(webView)
        if mode == .local { log("Local workspace navigation finished") }
    }

    private func showCommittedPage(_ webView: WKWebView) {
        guard webView === self.webView, isAllowedNavigation(webView.url), !switching, !terminating, !pageLoadFailed else { return }
        if mode == .local && (runtime?.isRunning != true || runtimeFailed) { return }
        spinner.stopAnimation(nil)
        statusView.isHidden = true
        webView.isHidden = false
        if mode == .cloud {
            window.title = (NavigationPolicy.isAuthenticationURL(webView.url) || NavigationPolicy.isClawHuntSSOURL(webView.url)) ? "AwwO · 登录" : "AwwO"
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView, let navigation { navigationFailed(navigation, error: error) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView, let navigation { navigationFailed(navigation, error: error) }
    }
    private func navigationFailed(_ navigation: WKNavigation, error: Error) {
        guard !terminating, !switching, pageLoad.cancel(navigation) else { return }
        let value = error as NSError
        if value.domain == NSURLErrorDomain && (value.code == NSURLErrorCancelled ||
            (value.code == NSURLErrorTimedOut && pageLoad.hasCommittedDocument)) {
            if pageLoad.hasCommittedDocument { showCommittedPage(webView) }
            return
        }
        if mode == .cloud {
            fail("线上工作区加载失败", detail: "\(error.localizedDescription)\n请检查网络后重新载入，或在默认浏览器访问 awwo.clawhunt.store。")
        } else { fail("本机工作区加载失败", detail: "\(error.localizedDescription)\n可重新载入，或从“显示”菜单查看运行日志。") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        fail("工作台显示进程已停止", detail: "请重新载入工作台。已保存的数据仍保留在当前工作区。")
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard webView === self.webView, !switching, !terminating,
            isApplicationFrame(frame), isApplicationURL(webView.url) else { completionHandler(nil); return }
        let panelGeneration = generation
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { [weak self, weak webView] response in
            guard let self, let webView, self.generation == panelGeneration,
                webView === self.webView, self.isApplicationURL(webView.url) else { completionHandler(nil); return }
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard webView === self.webView, isApplicationFrame(frame), isApplicationURL(webView.url), !switching, !terminating else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = "AwwO"
        alert.informativeText = String(message.prefix(4000))
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard webView === self.webView, isApplicationFrame(frame), isApplicationURL(webView.url), !switching, !terminating else { completionHandler(false); return }
        let panelGeneration = generation
        let alert = NSAlert()
        alert.messageText = "AwwO"
        alert.informativeText = String(message.prefix(4000))
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { [weak self] result in
            completionHandler(self?.generation == panelGeneration && result == .alertFirstButtonReturn)
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard webView === self.webView, isApplicationFrame(frame), isApplicationURL(webView.url), !switching, !terminating else { completionHandler(nil); return }
        let panelGeneration = generation
        let alert = NSAlert()
        alert.messageText = "AwwO"
        alert.informativeText = String(prompt.prefix(4000))
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { [weak self] result in
            completionHandler(self?.generation == panelGeneration && result == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        register(download, source: webView)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        register(download, source: webView)
    }
    private func register(_ download: WKDownload, source: WKWebView) {
        guard source === webView, !switching, !terminating, isApplicationURL(source.url) else { download.cancel { _ in }; return }
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
        suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard downloads[ObjectIdentifier(download)] != nil, !switching, !terminating,
            isApplicationURL(response.url), isApplicationURL(webView?.url) else { completionHandler(nil); return }
        let panelGeneration = generation
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.generation == panelGeneration,
                self.downloads[ObjectIdentifier(download)] != nil else { completionHandler(nil); return }
            completionHandler(response == .OK ? panel.url : nil)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard downloads.removeValue(forKey: ObjectIdentifier(download)) != nil else { return }
        if mode == .local { log("Local file export completed") }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard downloads.removeValue(forKey: ObjectIdentifier(download)) != nil,
            (error as NSError).code != NSURLErrorCancelled, !switching, !terminating else { return }
        let alert = NSAlert()
        alert.messageText = "文件导出失败"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(downloads[ObjectIdentifier(download)] != nil && !switching && !terminating && isApplicationURL(request.url) ? .allow : .cancel)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard mode == .local, !switching, !terminating, userContentController === webView?.configuration.userContentController,
            message.name == "localDiagnostics", isLocal(message.frameInfo),
            let body = message.body as? [String: Any], let kind = body["kind"] as? String,
            let detail = body["message"] as? String else { return }
        log("Web \(kind): \(String(detail.prefix(512)))")
    }

    @objc private func reloadPage() {
        // Not while the runtime's processes are being ended (forceCleanup): a start now would take its place.
        guard !switching, !terminating, !cleaning, !choosing, !forcedCleanupRunning else { return }
        if cleanupNeedsAttention, let process = runtime {
            switching = true
            pendingMode = .local
            statusHeading.stringValue = "正在重试关闭本机服务"
            spinner.startAnimation(nil)
            stopRuntime(process)
            return
        }
        // A runtime that has exited has its end on its way (runtimeExited, queued), which stops what it left first.
        if mode == .local, let process = runtime, !process.isRunning { return }
        if mode == .local && runtime == nil {
            generation = UUID()
            removeWebView()
            beginWorkspace(.local)
            return
        }
        guard let url = mode == .cloud ? cloudURL : localURL else { return }
        statusHeading.stringValue = "正在载入工作台"
        statusDetail.stringValue = mode == .cloud ? "正在访问 awwo.clawhunt.store，线上账号与历史记录保存在原工作区。" : "正在打开独立本机工作区。"
        statusView.isHidden = false
        webView.isHidden = true
        spinner.startAnimation(nil)
        // Restart Access from the application URL instead of replaying an expired
        // authentication token embedded in an intermediate redirect URL.
        loadPage(isApplicationURL(webView.url) && webView.url?.scheme != "blob" ? webView.url! : url)
    }
    @objc private func goBack() {
        guard !switching, !terminating, webView?.canGoBack == true else { return }
        webView.goBack()
    }
    @objc private func goForward() {
        guard !switching, !terminating, webView?.canGoForward == true else { return }
        webView.goForward()
    }
    @objc private func openMainSiteLogin() {
        guard mode == .cloud, mainSiteLoginAvailable, !switching, !terminating else { return }
        statusHeading.stringValue = "正在打开主站登录"
        statusDetail.stringValue = "请在此应用内正常登录。完成后选择“显示 → 工作区首页”，重新开始 AwwO 登录。"
        spinner.startAnimation(nil)
        // Use the existing WebView and its normal cookie store. Never replay the
        // denied authorization URL, transfer cookies, or change OAuth parameters.
        loadPage(NavigationPolicy.mainSiteLoginURL)
    }
    @objc private func openWorkspaceHome() {
        guard !switching, !terminating, !choosing else { return }
        if mode == .local {
            if let url = localURL { loadPage(url) }
            return
        }
        if mainSiteLoginAvailable {
            statusHeading.stringValue = "正在返回 AwwO"
            statusDetail.stringValue = "返回后，点击“使用 ClawHunt 账号继续”重新开始登录。"
            spinner.startAnimation(nil)
        }
        loadPage(cloudURL)
    }
    @objc private func openInBrowser() {
        guard !switching, !terminating, !choosing else { return }
        if mode == .local { openLocalInBrowser(); return }
        NSWorkspace.shared.open(isApplicationURL(webView?.url) && webView?.url?.scheme != "blob" ? webView.url! : cloudURL)
    }
    /// The local workspace in the browser, at its data folder's own address (the window's 127.0.0.1 address is the
    /// window's alone). Safari before macOS 26 cannot open *.localhost names; Chrome, Edge and Firefox can.
    @objc private func openLocalInBrowser() {
        guard mode == .local, !switching, !terminating, let browser = browserURL else { return }
        var page = browser
        if let current = webView?.url, current.scheme != "blob", isApplicationURL(current),
            var components = URLComponents(url: current, resolvingAgainstBaseURL: false) {
            components.host = browser.host
            components.port = browser.port
            page = components.url ?? browser
        }
        NSWorkspace.shared.open(page)
    }
    /// The data folder once the runtime has made it; before, the folder above it. The window never makes the data folder
    /// itself: the runtime makes it, private, at its first start.
    @objc private func openDataDirectory() {
        guard let paths = localPaths, !terminating else { return }
        if FileManager.default.fileExists(atPath: paths.state.path) { NSWorkspace.shared.open(paths.state); return }
        try? FileManager.default.createDirectory(at: paths.home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        NSWorkspace.shared.open(paths.home)
    }
    @objc private func openLog() {
        guard let paths = localPaths, !terminating else { return }
        try? FileManager.default.createDirectory(at: paths.logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        NSWorkspace.shared.open(paths.logs)
    }
    @objc private func showAbout() {
        var details = mode == .cloud
            ? "正式版\n地址：\(cloudURL.absoluteString)\n使用同一份账号、工作区和历史记录，界面随正式网站更新。"
            : "本机工作区：AwwO 本地版（独立数据）\n数据目录：\(localPaths?.state.path ?? "")\n本机账号与数据不与线上工作区同步。"
        if let url = Bundle.main.resourceURL?.appendingPathComponent("metadata.json"),
            let data = try? Data(contentsOf: url),
            let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let fields = mode == .cloud ? [("version", "桌面壳版本"), ("builtAt", "桌面壳构建时间")]
                : [("version", "桌面壳版本"), ("revision", "本机资源源码版本"), ("builtAt", "构建时间")]
            for (key, label) in fields {
                if let value = metadata[key] as? String { details += "\n\(label)：\(value)" }
            }
        }
        let alert = NSAlert()
        alert.messageText = "AwwO"
        alert.informativeText = details
        alert.beginSheetModal(for: window)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        pendingMode = nil
        generation = UUID()
        removeWebView()
        // The end of a runtime still stopping what it left: the app exits once it has (completeRuntimeExit).
        if cleaning { return .terminateLater }
        guard let process = runtime else { return .terminateNow }
        statusHeading.stringValue = "正在退出 AwwO"
        statusDetail.stringValue = "AwwO 本地版正在有序停止：先停 API，再停执行服务和数据库（最多几分钟）。"
        statusView.isHidden = false
        spinner.startAnimation(nil)
        // One that has exited already (crashed, ended from outside) has its end on its way (runtimeExited, queued), which
        // stops the database it left running and then lets the app quit.
        if process.isRunning || cleanupNeedsAttention || stopOwnership != nil { stopRuntime(process) }
        return .terminateLater
    }

    /// How long the runtime's stop in order may take before it is ended: its API is given 55 s at most, its workers 30 s
    /// and its database up to 120 s (scripts/awwo-local.mjs), as AwwO Local's window on Windows gives it.
    private let stopDeadline: TimeInterval = 240

    private func stopRuntime(_ process: Process) {
        // A Quit during a mode switch keeps the same pending stop and deadline.
        if shutdownTimer?.isValid == true || forcedCleanupRunning { return }
        if cleanupNeedsAttention {
            // One that has exited with nothing of it recorded cannot be found by its pid any more (another process may
            // have it by now): what is left of its end is the window's own (completeRuntimeExit: the database it left).
            if !process.isRunning && stopOwnership == nil {
                completeRuntimeExit(process, status: pendingExitStatus ?? process.terminationStatus)
                return
            }
            do {
                if stopOwnership == nil { stopOwnership = try RuntimeStopOwnership(pid: process.processIdentifier) }
                if let ownership = stopOwnership { forceCleanup(process, ownership: ownership) }
            } catch {
                // Defer until applicationShouldTerminate has returned terminateLater.
                DispatchQueue.main.async { [weak self] in self?.cleanupFailed(error) }
            }
            return
        }
        // Closing its standard input is the runtime's stop in order (--stop-on-stdin-close): the API first, while the
        // workers and the database it records into still run, then the workers, then the database. No signal: one more
        // during its stop would end its services at once. Its parent-PID watch is the fallback for a crash of this app.
        try? runtimeInput?.fileHandleForWriting.close()
        runtimeInput = nil
        // What it started, recorded now while it runs, for the deadline's end of it and for what may outlive it; a record
        // that cannot be made now (ps slow under load) is made again at the deadline, and the stop goes on meanwhile.
        if stopOwnership == nil, process.isRunning { stopOwnership = try? RuntimeStopOwnership(pid: process.processIdentifier) }
        let deadline = Timer(timeInterval: stopDeadline, repeats: false) { [weak self] _ in
            // One that has exited meanwhile has its end on its way (runtimeExited).
            guard let self, self.runtime === process, process.isRunning || self.stopOwnership != nil else { return }
            self.log("Runtime exceeded its \(Int(self.stopDeadline))-second stop deadline; ending it")
            do {
                if self.stopOwnership == nil { self.stopOwnership = try RuntimeStopOwnership(pid: process.processIdentifier) }
            } catch {
                self.cleanupFailed(error)
                return
            }
            if let ownership = self.stopOwnership { self.forceCleanup(process, ownership: ownership) }
        }
        // In the common modes: while a Quit waits (terminateLater) AppKit runs the main run loop in its modal-panel mode,
        // where a timer of the default mode alone never fires.
        RunLoop.main.add(deadline, forMode: .common)
        shutdownTimer = deadline
    }

    private func forceCleanup(_ process: Process, ownership: RuntimeStopOwnership) {
        guard !forcedCleanupRunning else { return }
        forcedCleanupRunning = true
        shutdownTimer?.invalidate()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result: Result<Void, Error>
            do { try ownership.forceCleanup(); result = .success(()) }
            catch { result = .failure(error) }
            DispatchQueue.main.async {
                guard let self else { return }
                // Before the check below: a cleanup that ends after another runtime took this one's place (none should,
                // reloadPage waits for it) must not leave every later stop waiting for it.
                self.forcedCleanupRunning = false
                guard self.runtime === process else { return }
                switch result {
                case .success:
                    self.completeRuntimeExit(process, status: self.pendingExitStatus ?? SIGKILL)
                case .failure(let error): self.cleanupFailed(error)
                }
            }
        }
    }

    private func cleanupFailed(_ error: Error) {
        shutdownTimer?.invalidate()
        forcedCleanupRunning = false
        cleanupNeedsAttention = true
        pendingMode = nil
        switching = false
        if terminating {
            terminating = false
            NSApp.reply(toApplicationShouldTerminate: false)
        }
        if webView == nil { makeWebView() }
        fail("本机服务尚未完全关闭", detail: "\(error.localizedDescription)\n已保留本机模式。可重新载入以重试清理；不会将残留服务当作成功退出。")
    }
    func applicationWillTerminate(_ notification: Notification) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "localDiagnostics")
        try? logHandle?.close()
    }
}

private struct LaunchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private var shutdownFixtureStop: sig_atomic_t = 0

// Standalone self-test children: no AppKit session, application data or network.
private func runShutdownFixture(_ role: String, group: pid_t? = nil) -> Never {
    if role == "unrelated" {
        if getpgrp() != getpid(), setsid() < 0 { exit(2) }
        while true { pause() }
    }
    if role.hasSuffix("-leaf") {
        guard let group, group > 1, setpgid(0, group) == 0 else { exit(2) }
        if role.hasPrefix("stuck") { signal(SIGTERM, SIG_IGN) }
        while true { pause() }
    }
    if role.hasSuffix("-group") {
        if getpgrp() != getpid(), setsid() < 0 { exit(2) }
        if role.hasPrefix("stuck") { signal(SIGTERM, SIG_IGN) }
    }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    child.arguments = ["--shutdown-fixture", role.hasSuffix("-group") ? role.replacingOccurrences(of: "-group", with: "-leaf") : role + "-group"]
    if role.hasSuffix("-group") { child.arguments?.append(String(getpgrp())) }
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    do { try child.run() } catch { exit(2) }
    if role.hasSuffix("-group") { while true { pause() } }
    signal(SIGTERM) { _ in shutdownFixtureStop = 1 }
    while shutdownFixtureStop == 0 { usleep(20_000) }
    kill(-child.processIdentifier, role == "stuck" ? SIGKILL : SIGTERM)
    child.waitUntilExit()
    exit(0)
}

private func testRuntimeShutdown() throws {
    func launch(_ role: String) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        process.arguments = ["--shutdown-fixture", role]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }
    func wait(_ description: String, _ condition: () throws -> Bool) throws {
        let deadline = Date().addingTimeInterval(5)
        while try !condition() {
            if Date() >= deadline { throw LaunchError("Shutdown self-test timeout: \(description)") }
            usleep(50_000)
        }
    }
    let unrelated = try launch("unrelated")
    guard let unrelatedIdentity = OwnedProcessIdentity.read(unrelated.processIdentifier) else { throw LaunchError("Missing unrelated fixture identity") }
    defer {
        if unrelatedIdentity.matches(OwnedProcessIdentity.read(unrelated.processIdentifier)) { kill(unrelated.processIdentifier, SIGKILL) }
        unrelated.waitUntilExit()
    }
    for role in ["normal", "stuck"] {
        let fixture = try launch(role)
        let ownership = try RuntimeStopOwnership(pid: fixture.processIdentifier)
        defer {
            if fixture.isRunning { kill(fixture.processIdentifier, SIGCONT); fixture.terminate() }
            try? ownership.forceCleanup(childGrace: 0.1, killGrace: 2)
            fixture.waitUntilExit()
        }
        try wait("detached child and grandchild ready") { try ownership.detachedFixtureReady() }
        if role == "normal" {
            fixture.terminate()
            try wait("normal graceful shutdown") { try !ownership.hasSurvivors(includeRoot: true) }
            fixture.waitUntilExit()
            guard fixture.terminationStatus == 0 else { throw LaunchError("Normal fixture did not exit cleanly") }
        } else {
            guard kill(fixture.processIdentifier, SIGSTOP) == 0 else { throw LaunchError("Could not stop fixture supervisor") }
            fixture.terminate() // SIGTERM remains pending while the supervisor is stopped.
            guard try ownership.hasSurvivors(includeRoot: true) else { throw LaunchError("Stopped fixture was mistaken for an exited process") }
            try ownership.forceCleanup(childGrace: 0.15, killGrace: 2)
            fixture.waitUntilExit()
            guard try !ownership.hasSurvivors(includeRoot: true) else { throw LaunchError("Fault cleanup left an owned process alive") }
        }
        guard unrelatedIdentity.matches(OwnedProcessIdentity.read(unrelated.processIdentifier)), unrelated.isRunning else {
            throw LaunchError("Shutdown cleanup touched an unrelated process")
        }
    }
    print("Runtime shutdown: normal exit, SIGSTOP supervisor, detached child/grandchild cleanup and unrelated-process preservation passed")
}

private func testNavigationPolicy() throws {
    let cloud = NavigationPolicy.cloudURL
    let local = URL(string: "http://127.0.0.1:5189")!
    var checks = 0
    func check(_ result: Bool, _ expected: Bool, _ label: String) throws {
        checks += 1
        if result != expected { throw LaunchError("Navigation policy failed: \(label)") }
    }
    for (value, accepted) in [
        ("https://awwo.clawhunt.store/", true),
        ("https://awwo.clawhunt.store:443/workspace", true),
        ("http://awwo.clawhunt.store/", false),
        ("https://awwo.clawhunt.store:444/", false),
        ("https://awwo.clawhunt.store.evil.example/", false),
        ("https://awwo.clawhunt.store@evil.example/", false),
        ("https://user@awwo.clawhunt.store/", false),
        ("https://user:password@awwo.clawhunt.store/", false),
        ("file:///tmp/index.html", false),
        ("about:blank", false),
        ("blob:https://awwo.clawhunt.store/opaque-id", true),
        ("blob:https://awwo.clawhunt.store:443/opaque-id", true),
        ("blob:https://awwo.clawhunt.store.evil.example/opaque-id", false),
        ("blob:https://user@awwo.clawhunt.store/opaque-id", false),
        ("blob:blob:https://awwo.clawhunt.store/opaque-id", false),
        ("blob:null/opaque-id", false),
        ("http://127.0.0.1:5189/", false)
    ] { try check(NavigationPolicy.sameOrigin(URL(string: value), cloud, allowBlob: true), accepted, value) }
    let access = "https://\(NavigationPolicy.accessHost)"
    for (value, accepted) in [
        (access + "/cdn-cgi/access/login/awwo.clawhunt.store?state=test", true),
        (access + ":443/cdn-cgi/access/callback", true),
        (access + "/cdn-cgi/access", true),
        (access + "/cdn-cgi/access-evil/login", false),
        (access + "/cdn-cgi/access/../outside", false),
        (access + "/cdn-cgi/access/%2e%2e/outside", false),
        (access + "/other/login", false),
        (access + ".evil.example/cdn-cgi/access/login", false),
        ("https://other.cloudflareaccess.com/cdn-cgi/access/login", false),
        ("https://user@\(NavigationPolicy.accessHost)/cdn-cgi/access/login", false),
        ("http://\(NavigationPolicy.accessHost)/cdn-cgi/access/login", false),
        (access + ":444/cdn-cgi/access/login", false)
    ] { try check(NavigationPolicy.isAuthenticationURL(URL(string: value)), accepted, value) }
    for (value, accepted) in [
        ("https://clawhunt.store/api/awwo/sso/authorize?client_id=test&state=test", true),
        ("https://clawhunt.store/api/awwo/sso/logout?ticket=test", true),
        ("https://clawhunt.store/login?redirect=%2Fapi%2Fawwo%2Fsso%2Fauthorize", true),
        ("https://clawhunt.store/register", true),
        ("https://clawhunt.store/account#profile", true),
        ("https://clawhunt.store/awwo", true),
        ("https://clawhunt.store/awwo?from=signin", true),
        ("https://clawhunt.store/awwo?from=signin&return=%2Fapi%2Fawwo%2Fsso%2Fauthorize#redeem", true),
        ("https://CLAWHUNT.STORE:443/awwo?from=signin", true),
        ("https://clawhunt.store/awwo/", false),
        ("https://clawhunt.store/awwo/redeem", false),
        ("https://clawhunt.store/awwo-evil?from=signin", false),
        ("https://clawhunt.store/AwwO", false),
        ("https://clawhunt.store//awwo", false),
        ("https://clawhunt.store/%61wwo", false),
        ("https://clawhunt.store/%2Fawwo", false),
        ("https://clawhunt.store/awwo%2F", false),
        ("https://clawhunt.store/login/../awwo", false),
        ("https://clawhunt.store/login/%2e%2e/awwo", false),
        ("https://clawhunt.store/awwo/../account", false),
        ("https://clawhunt.store/?next=%2Fawwo", false),
        ("https://clawhunt.store.evil.example/awwo?from=signin", false),
        ("https://clawhunt.store@evil.example/awwo", false),
        ("https://user@clawhunt.store/awwo", false),
        ("http://clawhunt.store/awwo", false),
        ("https://clawhunt.store:444/awwo", false),
        ("https://www.clawhunt.store/awwo", false),
        ("blob:https://clawhunt.store/awwo", false),
        ("https://clawhunt.store/api/awwo/sso/token", false),
        ("https://clawhunt.store/api/awwo/sso/logout-evil?ticket=test", false),
        ("https://clawhunt.store/api/awwo/sso/%2e%2e/logout", false),
        ("https://clawhunt.store/%61ccount", false),
        ("https://clawhunt.store//account", false),
        ("https://clawhunt.store.evil.example/login", false),
        ("https://clawhunt.store@evil.example/login", false),
        ("https://user@clawhunt.store/login", false),
        ("http://clawhunt.store/login", false),
        ("https://clawhunt.store:444/login", false),
        ("https://www.clawhunt.store/login", false),
        ("blob:https://clawhunt.store/login", false),
        ("file:///login", false)
    ] {
        try check(NavigationPolicy.isClawHuntSSOURL(URL(string: value)), accepted, value)
        try check(NavigationPolicy.isCloudNavigationURL(URL(string: value)), accepted, "cloud \(value)")
    }
    for (value, accepted) in [
        ("about:srcdoc", true), ("about:blank", true), ("about:srcdoc#section", true),
        ("about:blank?origin=local", false), ("about://example/blank", false), ("https://example.org/", false)
    ] { try check(NavigationPolicy.isEmbeddedPreview(URL(string: value)), accepted, value) }
    try check(NavigationPolicy.sameOrigin(URL(string: "blob:http://127.0.0.1:5189/export"), local, allowBlob: true), true, "local blob download")
    try check(NavigationPolicy.sameOrigin(URL(string: "blob:http://127.0.0.1:5190/export"), local, allowBlob: true), false, "wrong local blob port")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: "awwo.clawhunt.store", port: 443, origin: cloud), true, "cloud frame")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: "awwo.clawhunt.store", port: 0, origin: cloud), true, "cloud implicit port")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: NavigationPolicy.accessHost, port: 443, origin: cloud), false, "authentication has no native authority")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: NavigationPolicy.mainSiteHost, port: 443, origin: cloud), false, "main-site redemption has no native authority")
    try check(NavigationPolicy.frameMatches(protocol: "", host: "", port: 0, origin: cloud), false, "opaque preview has no native authority")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5189, origin: local), true, "local frame")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5190, origin: local), false, "wrong local frame port")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "localhost", port: 5189, origin: local), false, "local host alias not silently trusted")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5189, origin: cloud), false, "local frame cannot enter cloud authority")
    print("Navigation policy: \(checks) checks passed")
    try testNavigationHTTPFailures()
    try testMainSiteLoginRecovery()
    try testLocalContract()
}

/// The local edition's contract with its runtime (scripts/awwo-local.mjs): what a ready event must say, this launch's
/// token and the window's cookie. Synthetic events only: nothing is started.
private func testLocalContract() throws {
    var checks = 0
    func check(_ value: Bool, _ name: String) throws {
        guard value else { throw LaunchError("Local contract self-test failed: \(name)") }
        checks += 1
    }
    let state = URL(fileURLWithPath: "/Users/someone/Library/Application Support/store.clawhunt.awwo.local/state", isDirectory: true)
    func ready(_ url: String, _ window: String?, stateDir: String? = nil, event: String = "ready") -> [String: Any] {
        var value: [String: Any] = ["event": event, "url": url, "stateDir": stateDir ?? state.path, "services": ["api": true]]
        if let window { value["window"] = window }
        return value
    }
    let good = LocalReady.parse(ready("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199"), state: state)
    try check(good?.browser.absoluteString == "http://awwo-0123456789ab.localhost:5199" && good?.window.absoluteString == "http://127.0.0.1:5199", "a ready data folder opens at the window's address")
    try check(LocalReady.parse(ready("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199"), state: URL(fileURLWithPath: state.path + "/../state")) != nil, "the data folder is compared as a path")
    let refused: [(String, String?, String)] = [
        ("http://awwo-0123456789ab.localhost:5199", nil, "a ready event without the window's address"),
        ("https://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199", "https"),
        ("http://awwo.example:5199", "http://127.0.0.1:5199", "a name outside .localhost"),
        ("http://a.b.localhost:5199", "http://127.0.0.1:5199", "two names under .localhost"),
        ("http://-awwo.localhost:5199", "http://127.0.0.1:5199", "a name starting with a hyphen"),
        ("http://awwo-0123456789ab.localhost", "http://127.0.0.1:5199", "no port"),
        ("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5200", "another port for the window"),
        ("http://awwo-0123456789ab.localhost:5199", "http://localhost:5199", "a window at localhost"),
        ("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.2:5199", "a window at another loopback address"),
        ("http://user@awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199", "credentials"),
        ("http://awwo-0123456789ab.localhost:5199/admin", "http://127.0.0.1:5199", "a path"),
        ("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199/?x=1", "a query on the window")
    ]
    for (url, window, name) in refused {
        try check(LocalReady.parse(ready(url, window), state: state) == nil, name)
    }
    try check(LocalReady.parse(ready("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199", stateDir: "/tmp/other"), state: state) == nil, "another data folder's ready")
    try check(LocalReady.parse(ready("http://awwo-0123456789ab.localhost:5199", "http://127.0.0.1:5199", event: "status"), state: state) == nil, "another event")
    let token = try ShellToken.make()
    let another = try ShellToken.make()
    try check(ShellToken.isValid(token) && token != another, "a launch's token is 43 characters of base64url, new each time")
    for bad in ["", String(repeating: "A", count: 42), String(repeating: "A", count: 42) + "=", String(repeating: "A", count: 42) + "+", String(repeating: "A", count: 44)] {
        try check(!ShellToken.isValid(bad), "an invalid token: \(bad.count) characters")
    }
    let cookie = ShellToken.cookie(token)
    try check(cookie?.name == "awwo_shell" && cookie?.value == token && cookie?.domain == "127.0.0.1" && cookie?.path == "/", "the window's cookie names its token, for 127.0.0.1")
    try check(cookie?.isHTTPOnly == true && cookie?.isSessionOnly == true, "the window's cookie is unreadable by the page and ends with the session")
    try check(LocalReady.isLocalhostName("awwo-0123456789ab.localhost") && !LocalReady.isLocalhostName("localhost") && !LocalReady.isLocalhostName("AWWO.localhost"), "names under .localhost as the runtime makes them")
    // The loopback rule list: JSON WebKit takes, blocking every port of 127.0.0.1 but the window's own.
    let rules = try JSONSerialization.jsonObject(with: Data(LoopbackRule.json(port: 5199).utf8)) as? [[String: Any]]
    let filters = (rules ?? []).compactMap { ($0["trigger"] as? [String: Any])?["url-filter"] as? String }
    let actions = (rules ?? []).compactMap { ($0["action"] as? [String: Any])?["type"] as? String }
    try check(filters == ["^[a-z]+://127\\.0\\.0\\.1[:/]", "^[a-z]+://.*@127\\.0\\.0\\.1[:/]", "^http://127\\.0\\.0\\.1:5199/"]
        && actions == ["block", "block", "ignore-previous-rules"], "the loopback rules block 127.0.0.1, with user information too, then let the window's port through")
    func matches(_ pattern: String, _ url: String) throws -> Bool {
        let expression = try NSRegularExpression(pattern: pattern)
        return expression.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil
    }
    // (URL, blocked by a block rule, let through by the last.)
    let loads: [(String, Bool, Bool)] = [("http://127.0.0.1:3000/x.png", true, false), ("http://127.0.0.1/x", true, false),
        ("https://x@127.0.0.1:9443/capture", true, false), ("http://x:y@127.0.0.1:5199/", true, false),
        ("ws://127.0.0.1:5199/", true, false), ("http://127.0.0.1:5199/api/v1/auth/me", true, true),
        ("http://127.0.0.1:51990/", true, false), ("https://awwo.clawhunt.store/kits/x.js", false, false)]
    for (url, blocked, allowed) in loads {
        let plain = try matches(filters[0], url)
        let withUser = try matches(filters[1], url)
        let isBlocked = plain || withUser
        let isAllowed = try matches(filters[2], url)
        try check(isBlocked == blocked && isAllowed == allowed, "loopback rule on \(url)")
    }
    print("Local contract: \(checks) checks passed (synthetic events only)")
}

private func testMainSiteLoginRecovery() throws {
    var checks = 0
    func check(_ value: Bool, _ name: String) throws {
        guard value else { throw LaunchError("Login recovery self-test failed: \(name)") }
        checks += 1
    }
    func response(_ value: String, status: Int = 403, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: value)!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }
    let authorize = "https://clawhunt.store/api/awwo/sso/authorize"
    for url in [authorize, authorize + "?state=private-test-state&code_challenge=private-test-challenge",
        "https://CLAWHUNT.STORE:443/api/awwo/sso/authorize"] {
        try check(NavigationHTTPFailure.offersMainSiteLogin(response(url), cloud: true), "approved authorization denial")
        try check(!NavigationHTTPFailure.offersMainSiteLogin(response(url), cloud: false), "local mode excluded")
    }
    for status in [200, 302, 400, 401, 404, 429, 500, 503] {
        try check(!NavigationHTTPFailure.offersMainSiteLogin(response(authorize, status: status), cloud: true), "only HTTP 403")
    }
    for url in [
        "http://clawhunt.store/api/awwo/sso/authorize", "https://clawhunt.store:444/api/awwo/sso/authorize",
        "https://user@clawhunt.store/api/awwo/sso/authorize", "https://user:pass@clawhunt.store/api/awwo/sso/authorize",
        "https://clawhunt.store.evil.test/api/awwo/sso/authorize", "https://www.clawhunt.store/api/awwo/sso/authorize",
        "https://clawhunt.store./api/awwo/sso/authorize", "https://awwo.clawhunt.store/api/awwo/sso/authorize",
        "https://\(NavigationPolicy.accessHost)/cdn-cgi/access/login", "https://clawhunt.store/login",
        "https://clawhunt.store/account", "https://clawhunt.store/awwo", "https://clawhunt.store/api/awwo/sso/logout",
        authorize + "/", authorize + "/extra", authorize + "#fragment", authorize + "#",
        "https://clawhunt.store/api/awwo/sso/Authorize", "https://clawhunt.store/api/awwo/sso/%61uthorize",
        "https://clawhunt.store/api%2Fawwo/sso/authorize", "https://clawhunt.store/api/awwo/sso/../sso/authorize",
        "https://clawhunt.store/api/awwo/sso/%2e/authorize", "https://clawhunt.store//api/awwo/sso/authorize"
    ] {
        try check(!NavigationHTTPFailure.offersMainSiteLogin(response(url), cloud: true), "unapproved URL: \(url)")
    }
    try check(!NavigationPolicy.isClawHuntAuthorizationURL(nil), "missing URL excluded")
    try check(!NavigationHTTPFailure.offersMainSiteLogin(response("https://clawhunt.store/login", headers: [
        "Location": authorize, "CF-Ray": "0123456789abcdef-HKG"
    ]), cloud: true), "headers cannot select the recovery route")
    try check(NavigationPolicy.mainSiteLoginURL.absoluteString == "https://clawhunt.store/login", "fixed clean login destination")
    try check(NavigationPolicy.isClawHuntSSOURL(NavigationPolicy.mainSiteLoginURL), "login already belongs to approved navigation")
    try check(!NavigationPolicy.sameOrigin(NavigationPolicy.mainSiteLoginURL, NavigationPolicy.cloudURL), "login gains no application origin authority")
    print("Login recovery: \(checks) checks passed (synthetic responses only)")
}

private func testNavigationHTTPFailures() throws {
    var checks = 0
    func check(_ value: Bool, _ name: String) throws {
        guard value else { throw LaunchError("HTTP diagnostic self-test failed: \(name)") }
        checks += 1
    }
    func response(_ status: Int, _ headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://clawhunt.store/api/awwo/sso/authorize?state=private-test-state")!,
            statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }
    let ray = "0123456789abcdef-HKG"
    let known = NavigationHTTPFailure.detail(response(403, ["CF-Ray": ray,
        "Set-Cookie": "private-test-cookie", "Location": "https://example.test/?token=private-test-token"]), cloud: true)
    try check(known.contains("HTTP 403") && known.contains("Cloudflare 请求编号：\(ray)"), "safe response Ray is visible")
    try check(!known.contains("需完成") && !known.contains("等待批准"), "403 does not claim missing login or approval")
    try check(!known.contains("private-test") && !known.contains("https://"), "no other headers or URL are disclosed")
    let plain = NavigationHTTPFailure.detail(response(403), cloud: true)
    try check(plain.contains("拒绝") && !plain.contains("Cloudflare") && !plain.contains("登录"), "plain access denial remains distinct")
    for value in ["0123456789abcdef", ray, "0123456789ABCDEF-LAX"] {
        try check(NavigationHTTPFailure.detail(response(403, ["cf-ray": value]), cloud: true).contains(value), "valid Ray format")
    }
    for value in ["", "abc", "0123456789abcde", "0123456789abcdef0", "g123456789abcdef", ray + "-extra",
        ray + "\n", ray + "\r\nSet-Cookie: private", ray + "\u{202E}", ray + ", " + ray,
        "\(ray) private-test-token", String(repeating: "a", count: 10_000), "0123456789abcdef-香港", "0123456789abcdef-HK"] {
        let detail = NavigationHTTPFailure.detail(response(403, ["cf-ray": value]), cloud: true)
        try check(detail == plain, "invalid or oversized Ray is not reflected")
    }
    try check(NavigationHTTPFailure.detail(response(403, ["X-Request-ID": ray]), cloud: true) == plain, "only cf-ray is considered")
    try check(NavigationHTTPFailure.detail(response(403, ["CF-Ray": ray]), cloud: false) == plain, "local responses do not claim Cloudflare context")
    let other = NavigationHTTPFailure.detail(response(401, ["CF-Ray": ray]), cloud: true)
    try check(other.contains("HTTP 401") && !other.contains(ray), "non-403 behavior is unchanged")
    print("HTTP diagnostics: \(checks) checks passed (synthetic headers only)")
}

// Isolated WebKit fixture: no application delegate, windows, network, persistent
// cookie store, runtime, or user workspace is opened by this command.
private final class NavigationLoadFixture: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
    let monitor = NavigationLoadMonitor()
    private(set) var webView: WKWebView!
    private(set) var commits = 0
    private(set) var finishes = 0
    private(set) var timeouts: [Bool] = []
    private(set) var slowResourceRequested = false

    override init() {
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(self, forURLScheme: "awwo-load-test")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
        webView.navigationDelegate = self
    }
    func load(_ path: String) { webView.load(URLRequest(url: URL(string: "awwo-load-test://fixture/\(path)")!)) }
    func close() {
        monitor.reset()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView = nil
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let path = urlSchemeTask.request.url!.path
        if path == "/never" { return }
        if path == "/slow" { slowResourceRequested = true; return }
        let html = "<html><body><input id='draft' value='original'><select><option>one</option><option>two</option></select><img src='awwo-load-test://fixture/slow'></body></html>"
        let data = Data(html.utf8)
        urlSchemeTask.didReceive(URLResponse(url: urlSchemeTask.request.url!, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard let navigation else { return }
        monitor.start(navigation, timeout: 2) { [weak self] preserved in
            self?.timeouts.append(preserved)
            self?.webView.stopLoading()
        }
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if let navigation, monitor.commit(navigation) { commits += 1 }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let navigation, monitor.finish(navigation) { finishes += 1 }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if let navigation { monitor.cancel(navigation) }
    }
}

private func testNavigationLoading() throws {
    var checks = 0
    func check(_ value: Bool, _ name: String) throws {
        guard value else { throw LaunchError("Navigation loading self-test failed: \(name)") }
        checks += 1
    }
    func wait(_ seconds: TimeInterval, until ready: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !ready(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        guard ready() else { throw LaunchError("Navigation loading self-test timed out") }
    }
    func advance(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
    let monitor = NavigationLoadMonitor()
    let first = NSObject(), second = NSObject()
    var timeouts: [Bool] = []
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    monitor.start(second, timeout: 0.2) { timeouts.append($0) }
    try check(!monitor.commit(first) && !monitor.finish(first) && !monitor.cancel(first), "stale callbacks ignored")
    advance(0.08)
    try check(timeouts.isEmpty, "replaced timer cannot expire current navigation")
    try check(monitor.commit(second), "current commit accepted")
    advance(0.22)
    try check(timeouts.isEmpty && monitor.hasCommittedDocument, "commit cancels timer before finish")
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    monitor.prepareForNavigation()
    advance(0.08)
    try check(timeouts.isEmpty && monitor.hasCommittedDocument, "explicit reload disarms previous timer before didStart")
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    advance(0.08)
    try check(timeouts == [true], "uncommitted next navigation preserves prior document")
    monitor.reset()
    timeouts.removeAll()
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    try check(monitor.cancel(first), "current cancellation accepted")
    advance(0.08)
    try check(timeouts.isEmpty, "cancellation disarms deadline")
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    monitor.reset()
    advance(0.08)
    try check(timeouts.isEmpty && !monitor.hasCommittedDocument, "workspace reset disarms deadline and document")
    monitor.start(first, timeout: 0.04) { timeouts.append($0) }
    advance(0.08)
    try check(timeouts == [false], "first uncommitted document times out")
    try check(!monitor.commit(first), "expired navigation cannot revive page")

    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let slow = NavigationLoadFixture()
    defer { slow.close() }
    slow.load("ready")
    try wait(15) { slow.commits == 1 && slow.slowResourceRequested }
    var edited = false
    slow.webView.evaluateJavaScript("document.getElementById('draft').value = 'retained draft'; document.querySelector('select').selectedIndex = 1; true") { result, error in
        edited = error == nil && result as? Bool == true
    }
    try wait(5) { edited }
    advance(2.2)
    try check(slow.timeouts.isEmpty && slow.finishes == 0 && slow.webView.isLoading, "usable document with unfinished resource survives deadline")
    var retained = false
    slow.webView.evaluateJavaScript("document.getElementById('draft').value === 'retained draft' && document.querySelector('select').selectedIndex === 1") { result, error in
        retained = error == nil && result as? Bool == true
    }
    try wait(5) { retained }
    try check(retained, "edited input and selection remain available")
    slow.load("never")
    try wait(5) { !slow.timeouts.isEmpty }
    try check(slow.timeouts == [true] && slow.commits == 1, "real provisional timeout preserves existing document")
    retained = false
    slow.webView.evaluateJavaScript("document.getElementById('draft').value === 'retained draft' && document.querySelector('select').selectedIndex === 1") { result, error in
        retained = error == nil && result as? Bool == true
    }
    try wait(5) { retained }
    try check(retained && slow.webView.url?.path == "/ready", "stopping provisional load keeps prior document URL and editable draft")

    let empty = NavigationLoadFixture()
    defer { empty.close() }
    empty.load("never")
    try wait(15) { !empty.timeouts.isEmpty }
    try check(empty.timeouts == [false] && empty.commits == 0, "real first document timeout still reported")

    // The local window's loopback rule list, compiled by WebKit itself (its rules take a narrower syntax than
    // NSRegularExpression, which the policy self-test reads them with), in a store of its own in a temporary folder.
    let ruleFolder = FileManager.default.temporaryDirectory.appendingPathComponent("awwo-rule-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: ruleFolder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: ruleFolder) }
    // Typed as an optional: the SDK imports storeWithURL: as a plain initializer (an audited header) or as one returning
    // an implicitly unwrapped value (an older one), and this reads the same in both.
    let store: WKContentRuleListStore? = WKContentRuleListStore(url: ruleFolder)
    guard let ruleStore = store else { throw LaunchError("Navigation loading self-test: no content rule store") }
    var compiled: Bool?
    ruleStore.compileContentRuleList(forIdentifier: LoopbackRule.identifier(port: 5199), encodedContentRuleList: LoopbackRule.json(port: 5199)) { list, error in
        let ok = list != nil && error == nil
        DispatchQueue.main.async { compiled = ok }
    }
    try withExtendedLifetime(ruleStore) { try wait(15) { compiled != nil } }
    try check(compiled == true, "WebKit compiles the local window's loopback rule list")
    print("Navigation loading: \(checks) checks passed (including isolated WebKit slow-resource and uncommitted-document fixtures, and the loopback rule list)")
}

private func testWindowLifecycle() throws {
    _ = NSApplication.shared
    let window = makeWorkspaceWindow()
    guard !window.isReleasedWhenClosed else { throw LaunchError("Window ownership is not retained on close.") }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    var page: WKWebView? = WKWebView(frame: .zero, configuration: configuration)
    window.contentView = page
    window.close()
    // Match the accesses previously crashing inside removeWebView and reopen.
    _ = window.sheets
    page?.stopLoading()
    page?.navigationDelegate = nil
    page?.uiDelegate = nil
    page?.removeFromSuperview()
    page = nil
    window.orderBack(nil)
    window.close()
    guard window.title == "AwwO" else { throw LaunchError("Window did not survive close/reopen.") }
    print("Window lifecycle: owned close, WebKit teardown and reopen passed")
}

// Build-time utility: place the approved Fold raster on a macOS app tile.
// The bundled source is copied verbatim from assets/brand/awwo-fold, so the
// paths, transform and palette have one source of truth and cannot drift here.
private func writeIcon(to path: String) throws {
    guard let markURL = Bundle.main.url(forResource: "AwwOFoldMark", withExtension: "png"),
        let mark = NSImage(contentsOf: markURL),
        let markPixels = NSBitmapImageRep(data: try Data(contentsOf: markURL)),
        markPixels.pixelsWide == 1024, markPixels.pixelsHigh == 1024 else {
        throw LaunchError("应用包缺少已批准的 1024px Fold 图标资源。")
    }
    guard (path as NSString).isAbsolutePath,
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw LaunchError("图标输出需要绝对 PNG 路径。") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let tile = NSBezierPath(roundedRect: NSRect(x: 54, y: 54, width: 916, height: 916), xRadius: 210, yRadius: 210)
    NSColor(deviceRed: 248.0 / 255.0, green: 250.0 / 255.0, blue: 252.0 / 255.0, alpha: 1).setFill()
    tile.fill()
    mark.draw(in: NSRect(x: 128, y: 128, width: 768, height: 768),
        from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { throw LaunchError("无法编码应用图标。") }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

if CommandLine.arguments.count > 1 {
    if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--shutdown-fixture",
        ["normal-leaf", "stuck-leaf"].contains(CommandLine.arguments[2]), let group = Int32(CommandLine.arguments[3]) {
        runShutdownFixture(CommandLine.arguments[2], group: group)
    }
    if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--shutdown-fixture",
        ["normal", "stuck", "unrelated", "normal-group", "normal-leaf", "stuck-group", "stuck-leaf"].contains(CommandLine.arguments[2]) { runShutdownFixture(CommandLine.arguments[2]) }
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test-shutdown" {
        do { try testRuntimeShutdown(); exit(0) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)); exit(1) }
    }
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test-window" {
        do { try testWindowLifecycle(); exit(0) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)); exit(1) }
    }
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test-policy" {
        do { try testNavigationPolicy(); exit(0) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)); exit(1) }
    }
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test-navigation" {
        do { try testNavigationLoading(); exit(0) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)); exit(1) }
    }
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--write-icon" else {
        FileHandle.standardError.write(Data("Usage: AwwOLocal [--write-icon /absolute/icon.png | --self-test-policy | --self-test-shutdown | --self-test-navigation | --self-test-window]\n".utf8))
        exit(2)
    }
    do { try writeIcon(to: CommandLine.arguments[2]); exit(0) }
    catch { FileHandle.standardError.write(Data("Icon generation failed: \(error.localizedDescription)\n".utf8)); exit(1) }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
