import AppKit

struct ServiceView {
    var title: String
    var symbol: String
    var stopped = false
    var console = true
    var starting: Bool { title.hasPrefix("正在启动") }
    var error: Bool { title.contains("异常") || title.contains("失败") || title.contains("等待配置") || title.contains("重复进程") }
    static func read(_ output: String, _ code: Int32) -> ServiceView {
        guard let data = output.data(using: .utf8), let s = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let pids = s["pids"] as? [Int] else {
            return ServiceView(title: "服务异常 · 状态检查失败", symbol: "exclamationmark.triangle", console: false)
        }
        if pids.isEmpty { return ServiceView(title: "服务已停止", symbol: "stop.circle", stopped: true, console: false) }
        if pids.count > 1 { return ServiceView(title: "检测到重复进程 · 请查看详情", symbol: "exclamationmark.triangle") }
        if code == 3 { return ServiceView(title: "等待配置 · 请查看详情", symbol: "exclamationmark.triangle") }
        let health = s["health"] as? [String: String] ?? [:]
        if code == 2 || health.values.contains("error") { return ServiceView(title: "服务异常 · 组件健康检查失败", symbol: "exclamationmark.triangle") }
        if code != 0 { return ServiceView(title: "服务异常 · 健康检查无响应", symbol: "exclamationmark.triangle") }
        if s["paused"] as? Bool == true || health.values.contains("paused") {
            return ServiceView(title: "服务暂停", symbol: "pause.circle")
        }
        if health.isEmpty || health.values.contains("starting") {
            return ServiceView(title: "正在启动 · 等待组件就绪", symbol: "arrow.triangle.2.circlepath")
        }
        return ServiceView(title: "运行正常 · 所有组件 Ready", symbol: "checkmark.circle")
    }
}

let menuSymbols: [String: String] = [
    "打开控制台": "arrow.up.right.square", "启动服务": "play.fill",
    "停止服务": "stop.fill", "重启服务": "arrow.clockwise",
    "刷新状态": "arrow.triangle.2.circlepath", "查看状态详情": "info.circle",
    "打开日志目录": "folder", "高级选项": "gearshape",
    "退出控制器": "rectangle.portrait.and.arrow.right"
]
func menuImage(_ symbol: String, description: String) -> NSImage? {
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        ?? NSImage(systemSymbolName: "gearshape", accessibilityDescription: description)
        ?? (NSImage(named: NSImage.actionTemplateName)?.copy() as? NSImage)
    let configured = image?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)) ?? image
    configured?.size = NSSize(width: 16, height: 16)
    configured?.isTemplate = true
    return configured
}

final class Controller: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    let menu = NSMenu()
    var busy: String?
    var timer: Timer?
    var lastOutput = "尚未获取状态"
    var view = ServiceView(title: "正在检查状态…", symbol: "clock", console: false)
    var configuration: [String: String] = [:]
    var fish: NSImage?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let peers = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!)
        if let peer = peers.first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            peer.activate(options: []); NSApp.terminate(nil); return
        }
        guard let url = Bundle.main.url(forResource: "Controller", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let config = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: String],
              config["root"] != nil, config["python"] != nil else { NSApp.terminate(nil); return }
        configuration = config
        fish = Bundle.main.url(forResource: "WhaleTemplate", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
        fish?.size = NSSize(width: 20, height: 20); fish?.isTemplate = true
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = fish; item.button?.toolTip = "DSH SuperAgent"
        item.button?.setAccessibilityLabel("DSH SuperAgent")
        menu.autoenablesItems = false; item.menu = menu
        render(); refresh()
        timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
    }
    @discardableResult
    func entry(_ title: String, _ action: Selector?, in targetMenu: NSMenu? = nil, enabled: Bool = true) -> NSMenuItem {
        let e = NSMenuItem(title: title, action: action, keyEquivalent: "")
        if let symbol = menuSymbols[title] { e.image = menuImage(symbol, description: title) }
        e.target = self; e.isEnabled = enabled && action != nil
        (targetMenu ?? menu).addItem(e); return e
    }
    func render() {
        menu.removeAllItems()
        let heading = entry("DSH SuperAgent", nil); heading.image = fish
        let status = entry(busy != nil && busy != "status" ? ["start": "正在启动…", "stop": "正在停止服务…", "restart": "正在重启…"][busy!]! : view.title, #selector(details))
        status.image = menuImage(busy != nil && busy != "status" ? "arrow.triangle.2.circlepath" : view.symbol, description: status.title)
        menu.addItem(.separator())
        entry("打开控制台", #selector(console), enabled: view.console && busy != "stop")
        menu.addItem(.separator())
        if view.error { entry("查看状态详情", #selector(details)) }
        if view.stopped { entry("启动服务", #selector(start), enabled: busy == nil) }
        else {
            entry("重启服务", #selector(restart), enabled: busy == nil && !view.starting)
            entry("停止服务", #selector(stop), enabled: busy == nil)
        }
        menu.addItem(.separator())
        let advanced = NSMenu(); advanced.autoenablesItems = false
        let parent = entry("高级选项", nil); parent.submenu = advanced; parent.isEnabled = true
        entry("刷新状态", #selector(refresh), in: advanced, enabled: busy == nil)
        if !view.error { entry("查看状态详情", #selector(details), in: advanced) }
        entry("打开日志目录", #selector(logs), in: advanced)
        menu.addItem(.separator())
        entry("退出控制器", #selector(quitApp)).toolTip = "后台服务继续运行"
    }
    func run(_ action: String) {
        guard busy == nil else { return }; busy = action; render()
        let python = configuration["python"]!, root = configuration["root"]!
        DispatchQueue.global(qos: .utility).async {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = [root + "/scripts/dsh-superagent", action]
            process.environment = ["HOME": NSHomeDirectory(), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"]
            process.standardOutput = pipe; process.standardError = pipe
            let output: String; let code: Int32
            do { try process.run(); output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""; process.waitUntilExit(); code = process.terminationStatus }
            catch { output = error.localizedDescription; code = 1 }
            DispatchQueue.main.async {
                self.busy = nil
                if action == "status" { self.lastOutput = output; self.view = ServiceView.read(output, code); self.render() }
                else {
                    if code != 0 { self.show("操作未完成", output) }
                    self.refresh()
                }
            }
        }
    }
    func show(_ title: String, _ message: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = String(message.suffix(8000))
        alert.addButton(withTitle: "关闭"); alert.addButton(withTitle: "打开日志目录")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { logs() }
    }
    @objc func start() { run("start") }
    @objc func stop() { run("stop") }
    @objc func restart() { run("restart") }
    @objc func refresh() { run("status") }
    @objc func console() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:3082")!) }
    @objc func details() { show("SuperAgent 状态", lastOutput) }
    @objc func logs() { NSWorkspace.shared.open(URL(fileURLWithPath: configuration["root"]! + "/.artifacts/launchd")) }
    @objc func quitApp() { NSApp.terminate(nil) }
}
if CommandLine.arguments.contains("--test-states") {
    func check(_ json: String, _ code: Int32, _ title: String, _ stopped: Bool = false) {
        let v = ServiceView.read(json, code); precondition(v.title.contains(title) && v.stopped == stopped)
    }
    check("{\"pids\":[1],\"health\":{\"runtime\":\"ready\"}}", 0, "运行正常")
    check("{\"pids\":[]}", 1, "服务已停止", true)
    check("{\"pids\":[1],\"paused\":true}", 0, "服务暂停")
    check("{\"pids\":[1],\"health\":{\"github\":\"starting\"}}", 0, "正在启动")
    check("{\"pids\":[1],\"health\":null}", 1, "无响应")
    check("network error", 1, "检查失败")
    check("{\"pids\":[1,2]}", 1, "重复进程")
    check("{\"pids\":[1]}", 3, "等待配置")
    _ = NSApplication.shared
    let c = Controller()
    c.view = ServiceView(title: "Ready", symbol: "checkmark.circle")
    c.render()
    precondition(!c.menu.items.contains { $0.title == "启动服务" })
    precondition(c.menu.items.first { $0.title == "高级选项" }?.submenu?.items.count == 3)
    for (title, symbol) in menuSymbols {
        let image = menuImage(symbol, description: title)
        precondition(image != nil && image!.isTemplate && image!.size == NSSize(width: 16, height: 16))
    }
    precondition(menuImage("nonexistent.symbol.for.compatibility", description: "Fallback") != nil)
    func verifyImages(_ menu: NSMenu) {
        for e in menu.items {
            if menuSymbols[e.title] != nil { precondition(e.image?.isTemplate == true) }
            if let sub = e.submenu { verifyImages(sub) }
        }
    }
    verifyImages(c.menu)
    c.view = ServiceView(title: "Stopped", symbol: "stop.circle", stopped: true, console: false)
    c.render()
    precondition(c.menu.items.contains { $0.title == "启动服务" && $0.isEnabled })
    precondition(!c.menu.items.contains { $0.title == "停止服务" })
    precondition(c.menu.items.first { $0.title == "打开控制台" }?.isEnabled == false)
    verifyImages(c.menu)
    c.busy = "start"; c.render()
    precondition(c.menu.items.first { $0.title == "启动服务" }?.isEnabled == false)
    print("8 UI state cases and native menu structure/disabled-state checks passed")
} else {
    let app = NSApplication.shared
    let controller = Controller()
    app.delegate = controller; app.setActivationPolicy(.accessory); app.run()
}
