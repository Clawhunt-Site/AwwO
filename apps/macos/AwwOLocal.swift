import AppKit
import WebKit
import Darwin

private enum WorkspaceMode { case cloud, local }
private final class RuntimeOutputBuffer { var data = Data() }

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
        guard pid > 1, pid != getpid(), let root = OwnedProcessIdentity.read(pid), !root.zombie else {
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

    func forceCleanup(termGrace: TimeInterval = 1, killGrace: TimeInterval = 3) throws {
        // Freeze only the exact supervisor we launched, preventing new detached
        // children while its already-owned groups are reclaimed. Kill it last.
        try signalExact(root, SIGSTOP)
        defer { if root.matches(OwnedProcessIdentity.read(root.pid)) { try? signalExact(root, SIGCONT) } }
        observe(try snapshot())
        try signalChildren(SIGTERM)
        let termDeadline = Date().addingTimeInterval(termGrace)
        while try hasSurvivors(), Date() < termDeadline { usleep(50_000) }
        let killDeadline = Date().addingTimeInterval(killGrace)
        while try hasSurvivors(), Date() < killDeadline {
            try signalChildren(SIGKILL)
            usleep(50_000)
        }
        guard try !hasSurvivors() else { throw LaunchError("仍有本机子进程未退出，尚未切换环境。请重试关闭。") }
        try signalExact(root, SIGKILL)
        let rootDeadline = Date().addingTimeInterval(killGrace)
        while try hasSurvivors(includeRoot: true), Date() < rootDeadline { usleep(50_000) }
        guard try !hasSurvivors(includeRoot: true) else { throw LaunchError("本机运行进程尚未退出，环境切换已取消。") }
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
    private let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/AwwO Local", isDirectory: true)
    // The production package deliberately contains no independent local runtime.
    // Keep the proven process cleanup implementation for old local sessions, but
    // never expose or start it from this hosted production package.
    private let supportsLocalWorkspace = false
    private let cloudURL = NavigationPolicy.cloudURL
    private let cloudDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "C4B6F31C-57B1-49F0-873B-DA03351FAE72")!)
    private var mode: WorkspaceMode = .cloud
    private var generation = UUID()
    private var pendingMode: WorkspaceMode?
    private var switching = false
    private var pageLoadFailed = false
    private let pageLoad = NavigationLoadMonitor()
    private let outputQueue = DispatchQueue(label: "store.clawhunt.awwo.local.runtime-output")
    private var runtime: Process?
    private var outputPipe: Pipe?
    private var logHandle: FileHandle?
    private var startupTimer: Timer?
    private var shutdownTimer: Timer?
    private var stopOwnership: RuntimeStopOwnership?
    private var forcedCleanupRunning = false
    private var cleanupNeedsAttention = false
    private var pendingExitStatus: Int32?
    private var terminating = false
    private var terminationReplied = false
    private var runtimeFailed = false
    private var localURL: URL?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: NSView!
    private var statusHeading: NSTextField!
    private var statusDetail: NSTextField!
    private var spinner: NSProgressIndicator!

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }) {
            existing.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }
        makeMenu()
        makeWindow()
        beginWorkspace(.cloud)
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu(title: "AwwO")
        appItem.submenu = appMenu
        addItem("关于 AwwO", action: #selector(showAbout), to: appMenu)
        appMenu.addItem(.separator())
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
        let retryButton = NSButton(title: "重新载入", target: self, action: #selector(reloadPage))
        let stack = NSStackView(views: [spinner, statusHeading, statusDetail, retryButton])
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
        configuration.websiteDataStore = mode == .cloud ? cloudDataStore : .default()
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

    private func removeWebView() {
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

    private func beginWorkspace(_ selected: WorkspaceMode) {
        guard selected == .cloud || supportsLocalWorkspace else { return }
        mode = selected
        switching = false
        pendingMode = nil
        runtimeFailed = false
        pageLoadFailed = false
        localURL = nil
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
            statusHeading.stringValue = "正在启动本机工作区"
            statusDetail.stringValue = "本机账号与数据独立保存，不同步线上工作区。"
            startRuntime()
        }
    }

    @objc private func switchToCloud() { switchWorkspace(.cloud) }
    @objc private func switchToLocal() { switchWorkspace(.local) }
    private func switchWorkspace(_ selected: WorkspaceMode) {
        guard !terminating, !switching, selected != mode,
            selected == .cloud || supportsLocalWorkspace else { return }
        generation = UUID()
        switching = true
        pendingMode = selected
        startupTimer?.invalidate()
        removeWebView()
        statusView.isHidden = false
        spinner.startAnimation(nil)
        if let process = runtime, process.isRunning || cleanupNeedsAttention || stopOwnership != nil {
            statusHeading.stringValue = "正在关闭本机服务"
            statusDetail.stringValue = "等待本地数据库安全关闭后，进入线上工作区。"
            stopRuntime(process)
        } else {
            runtime = nil
            beginWorkspace(selected)
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(switchToCloud) {
            menuItem.state = mode == .cloud ? .on : .off
            return !switching && !terminating && mode != .cloud
        }
        if menuItem.action == #selector(switchToLocal) {
            menuItem.state = mode == .local ? .on : .off
            return supportsLocalWorkspace && !switching && !terminating && mode != .local
        }
        if [#selector(openModelConfiguration), #selector(openLocalCredentials), #selector(openDataDirectory), #selector(openLog)].contains(menuItem.action) {
            return mode == .local && !switching && !terminating
        }
        if menuItem.action == #selector(goBack) { return !switching && !terminating && webView?.canGoBack == true }
        if menuItem.action == #selector(goForward) { return !switching && !terminating && webView?.canGoForward == true }
        if [#selector(reloadPage), #selector(openInBrowser), #selector(openWorkspaceHome)].contains(menuItem.action) { return !switching && !terminating }
        return true
    }

    private func loadPage(_ url: URL) {
        pageLoadFailed = false
        pageLoad.prepareForNavigation()
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45))
    }

    private func startRuntime() {
        guard supportsLocalWorkspace, mode == .local, !switching, !terminating else { return }
        let launchGeneration = generation
        do {
            let files = FileManager.default
            let logs = stateDirectory.appendingPathComponent("logs", isDirectory: true)
            try files.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
            let logURL = logs.appendingPathComponent("runtime.log")
            if !files.fileExists(atPath: logURL.path) { files.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            try? logHandle?.close()
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()
            log("Launching bundled local runtime")
            guard let resources = Bundle.main.resourceURL else { throw LaunchError("应用资源目录缺失。") }
            let executable = resources.appendingPathComponent("bin/node")
            let script = resources.appendingPathComponent("runtime.ts")
            guard files.isExecutableFile(atPath: executable.path), files.fileExists(atPath: script.path) else {
                throw LaunchError("应用缺少 Node 运行时或 runtime.ts，请重新构建本地版本。")
            }
            let process = Process()
            process.executableURL = executable
            process.arguments = [script.path, resources.path, stateDirectory.path, String(ProcessInfo.processInfo.processIdentifier)]
            process.currentDirectoryURL = resources
            // Finder and shell launches use the same local configuration. Shell
            // credentials and NODE_OPTIONS cannot silently change this bundle.
            let inherited = ProcessInfo.processInfo.environment
            process.environment = [
                "HOME": files.homeDirectoryForCurrentUser.path,
                "PATH": "\(resources.appendingPathComponent("bin").path):/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": NSTemporaryDirectory(),
                "LANG": inherited["LANG"] ?? "en_US.UTF-8",
                "APP_ENV": "development"
            ]
            let pipe = Pipe()
            let buffer = RuntimeOutputBuffer()
            outputPipe = pipe
            process.standardOutput = pipe
            process.standardError = logHandle
            process.standardInput = FileHandle.nullDevice
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                self?.outputQueue.async { [weak self] in self?.consumeOutput(data, buffer: buffer, generation: launchGeneration) }
            }
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async { self?.runtimeExited(process, status: process.terminationStatus) }
            }
            runtime = process
            try process.run()
            startupTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { [weak self] _ in
                guard let self, self.generation == launchGeneration, self.mode == .local, self.localURL == nil else { return }
                self.runtimeFailed = true
                self.fail("本地服务启动超时", detail: "服务在 3 分钟内未完成启动。请查看运行日志，退出后重新启动。")
                if self.runtime?.isRunning == true { self.runtime?.terminate() }
            }
        } catch {
            fail("无法启动 AwwO Local", detail: error.localizedDescription)
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
        guard !terminating, !switching, mode == .local, self.generation == generation else { return }
        if event["event"] as? String == "error" {
            runtimeFailed = true
            fail("本地服务发生错误", detail: event["message"] as? String ?? "请查看运行日志。")
            if runtime?.isRunning == true { runtime?.terminate() }
            return
        }
        guard !runtimeFailed, event["event"] as? String == "ready", localURL == nil,
            let value = event["url"] as? String, let url = URL(string: value),
            url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? ""),
            let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil,
            let state = event["stateDir"] as? String,
            URL(fileURLWithPath: state).standardizedFileURL == stateDirectory.standardizedFileURL else {
            if event["event"] as? String == "ready" {
                runtimeFailed = true
                fail("本地服务返回了无效地址", detail: "仅允许当前应用管理的本机服务。请查看运行日志。")
                if runtime?.isRunning == true { runtime?.terminate() }
            }
            return
        }
        startupTimer?.invalidate()
        localURL = url
        log("Runtime ready: \(url.absoluteString)")
        statusDetail.stringValue = "本地服务已就绪，正在载入工作台。"
        loadPage(url)
    }

    private func runtimeExited(_ process: Process, status: Int32) {
        guard runtime === process else { return }
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
        startupTimer?.invalidate()
        shutdownTimer?.invalidate()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        runtime = nil
        stopOwnership = nil
        cleanupNeedsAttention = false
        pendingExitStatus = nil
        log("Runtime exited with status \(status)")
        if terminating {
            finishTermination()
        } else if let next = pendingMode {
            beginWorkspace(next)
        } else {
            localURL = nil
            fail("本地服务已停止", detail: "运行进程已退出（状态 \(status)）。请查看运行日志，退出后重新启动应用。")
        }
    }

    private func finishTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        shutdownTimer?.invalidate()
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    private func fail(_ title: String, detail: String) {
        guard window != nil else { return }
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
        statusDetail.stringValue = String(detail.prefix(1500))
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
        isApplicationURL(url) || (mode == .cloud && NavigationPolicy.isAuthenticationURL(url))
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
                detail: "服务器返回 HTTP \(response.statusCode)。请重新载入；线上访问需完成 Cloudflare Access 和 AwwO 账号登录。")
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
            (isApplicationFrame(navigationAction.sourceFrame) || (mode == .cloud && NavigationPolicy.isAuthenticationURL(navigationAction.sourceFrame.request.url))),
            let url = navigationAction.request.url else { return nil }
        if isAllowedNavigation(url) {
            pageLoad.prepareForNavigation()
            webView.load(navigationAction.request)
        } else { openExternal(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView, let navigation, !switching, !terminating else { return }
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
            window.title = NavigationPolicy.isAuthenticationURL(webView.url) ? "AwwO · 登录" : "AwwO"
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
        guard !switching, !terminating else { return }
        if cleanupNeedsAttention, let process = runtime {
            switching = true
            pendingMode = .local
            statusHeading.stringValue = "正在重试关闭本机服务"
            spinner.startAnimation(nil)
            stopRuntime(process)
            return
        }
        if mode == .local && runtime?.isRunning != true {
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
    @objc private func openWorkspaceHome() {
        guard !switching, !terminating else { return }
        loadPage(cloudURL)
    }
    @objc private func openInBrowser() {
        guard !switching, !terminating, let url = mode == .cloud ? cloudURL : localURL else { return }
        NSWorkspace.shared.open(isApplicationURL(webView?.url) && webView?.url?.scheme != "blob" ? webView.url! : url)
    }
    @objc private func openDataDirectory() {
        guard mode == .local, !switching, !terminating else { return }
        NSWorkspace.shared.open(stateDirectory)
    }
    @objc private func openLog() {
        guard mode == .local, !switching, !terminating else { return }
        let url = stateDirectory.appendingPathComponent("logs/runtime.log")
        if FileManager.default.fileExists(atPath: url.path) { NSWorkspace.shared.open(url) }
        else { NSWorkspace.shared.open(stateDirectory) }
    }
    @objc private func openModelConfiguration() {
        guard mode == .local, !switching, !terminating else { return }
        let url = stateDirectory.appendingPathComponent("models.env")
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
                configuration: NSWorkspace.OpenConfiguration())
        } else {
            let alert = NSAlert()
            alert.messageText = "模型配置尚未就绪"
            alert.informativeText = "本地服务首次启动后会创建 models.env。请稍后重试，或查看运行日志。"
            alert.beginSheetModal(for: window)
        }
    }
    @objc private func openLocalCredentials() {
        guard mode == .local, !switching, !terminating else { return }
        let url = stateDirectory.appendingPathComponent("admin-credentials.txt")
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
                configuration: NSWorkspace.OpenConfiguration())
        } else {
            let alert = NSAlert()
            alert.messageText = "本机登录凭据尚未就绪"
            alert.informativeText = "首次启动完成后，本地服务会生成管理员凭据。请稍后重试。"
            alert.beginSheetModal(for: window)
        }
    }
    @objc private func showAbout() {
        var details = mode == .cloud
            ? "正式版\n地址：\(cloudURL.absoluteString)\n使用同一份账号、工作区和历史记录，界面随正式网站更新。"
            : "当前环境：本机 development（独立数据）\n数据目录：\(stateDirectory.path)\n本机账号与数据不与线上工作区同步。"
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
        startupTimer?.invalidate()
        removeWebView()
        guard let process = runtime, process.isRunning || cleanupNeedsAttention || stopOwnership != nil else { return .terminateNow }
        statusHeading.stringValue = "正在退出 AwwO"
        statusDetail.stringValue = "正在关闭本地服务并保存数据库。"
        statusView.isHidden = false
        spinner.startAnimation(nil)
        stopRuntime(process)
        return .terminateLater
    }

    private func stopRuntime(_ process: Process) {
        // A Quit during a mode switch keeps the same pending stop and deadline.
        if shutdownTimer?.isValid == true || forcedCleanupRunning { return }
        do {
            if stopOwnership == nil { stopOwnership = try RuntimeStopOwnership(pid: process.processIdentifier) }
        } catch {
            // Defer until applicationShouldTerminate has returned terminateLater.
            DispatchQueue.main.async { [weak self] in self?.cleanupFailed(error) }
            return
        }
        if cleanupNeedsAttention, let ownership = stopOwnership { forceCleanup(process, ownership: ownership); return }
        process.terminate()
        // Let the runtime stop its child services and flush embedded storage.
        // Its independent parent-PID watchdog is the fallback for native crashes.
        shutdownTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            guard let self, self.runtime === process else { return }
            guard let ownership = self.stopOwnership else { self.cleanupFailed(LaunchError("缺少本次退出的进程归属记录。")); return }
            self.log("Runtime exceeded 20-second shutdown deadline; checking owned descendants")
            self.forceCleanup(process, ownership: ownership)
        }
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
                guard let self, self.runtime === process else { return }
                self.forcedCleanupRunning = false
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
            try? ownership.forceCleanup(termGrace: 0.1, killGrace: 2)
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
            try ownership.forceCleanup(termGrace: 0.15, killGrace: 2)
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
        ("about:srcdoc", true), ("about:blank", true), ("about:srcdoc#section", true),
        ("about:blank?origin=local", false), ("about://example/blank", false), ("https://example.org/", false)
    ] { try check(NavigationPolicy.isEmbeddedPreview(URL(string: value)), accepted, value) }
    try check(NavigationPolicy.sameOrigin(URL(string: "blob:http://127.0.0.1:5189/export"), local, allowBlob: true), true, "local blob download")
    try check(NavigationPolicy.sameOrigin(URL(string: "blob:http://127.0.0.1:5190/export"), local, allowBlob: true), false, "wrong local blob port")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: "awwo.clawhunt.store", port: 443, origin: cloud), true, "cloud frame")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: "awwo.clawhunt.store", port: 0, origin: cloud), true, "cloud implicit port")
    try check(NavigationPolicy.frameMatches(protocol: "https", host: NavigationPolicy.accessHost, port: 443, origin: cloud), false, "authentication has no native authority")
    try check(NavigationPolicy.frameMatches(protocol: "", host: "", port: 0, origin: cloud), false, "opaque preview has no native authority")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5189, origin: local), true, "local frame")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5190, origin: local), false, "wrong local frame port")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "localhost", port: 5189, origin: local), false, "local host alias not silently trusted")
    try check(NavigationPolicy.frameMatches(protocol: "http", host: "127.0.0.1", port: 5189, origin: cloud), false, "local frame cannot enter cloud authority")
    print("Navigation policy: \(checks) checks passed")
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
    print("Navigation loading: \(checks) checks passed (including isolated WebKit slow-resource and uncommitted-document fixtures)")
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

// Build-time utility: produce the app's original artwork without external tools,
// an interactive application session, or any dependency on the legacy desktop.
private func writeIcon(to path: String) throws {
    guard (path as NSString).isAbsolutePath,
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw LaunchError("图标输出需要绝对 PNG 路径。") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    // ClawHunt iOS blue anchors the native app. A continuous, rounded double arch
    // forms the lowercase "w" without tiny details that disappear in the Dock.
    let tile = NSBezierPath(roundedRect: NSRect(x: 54, y: 54, width: 916, height: 916), xRadius: 210, yRadius: 210)
    let forest = NSGradient(starting: NSColor(calibratedRed: 0.184, green: 0.490, blue: 0.965, alpha: 1),
        ending: NSColor(calibratedRed: 0.086, green: 0.310, blue: 0.769, alpha: 1))!
    forest.draw(in: tile, angle: -68)
    NSColor(calibratedRed: 0.80, green: 0.89, blue: 1.0, alpha: 0.20).setStroke()
    tile.lineWidth = 2
    tile.stroke()

    let mark = NSBezierPath()
    mark.lineWidth = 104
    mark.lineCapStyle = .round
    mark.lineJoinStyle = .round
    mark.move(to: NSPoint(x: 245, y: 662))
    mark.line(to: NSPoint(x: 334, y: 405))
    mark.curve(to: NSPoint(x: 416, y: 405), controlPoint1: NSPoint(x: 349, y: 365), controlPoint2: NSPoint(x: 400, y: 365))
    mark.line(to: NSPoint(x: 480, y: 570))
    mark.curve(to: NSPoint(x: 544, y: 570), controlPoint1: NSPoint(x: 493, y: 604), controlPoint2: NSPoint(x: 531, y: 604))
    mark.line(to: NSPoint(x: 608, y: 405))
    mark.curve(to: NSPoint(x: 690, y: 405), controlPoint1: NSPoint(x: 624, y: 365), controlPoint2: NSPoint(x: 675, y: 365))
    mark.line(to: NSPoint(x: 779, y: 662))
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedRed: 0.01, green: 0.03, blue: 0.12, alpha: 0.24)
    shadow.shadowOffset = NSSize(width: 0, height: -7)
    shadow.shadowBlurRadius = 15
    shadow.set()
    NSColor(calibratedRed: 1, green: 1, blue: 1, alpha: 1).setStroke()
    mark.stroke()
    NSGraphicsContext.restoreGraphicsState()
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
