import AppKit

// Native client of the local, allowlisted business runtime helper.
struct RuntimeRun: Decodable {
    var status: String
    var startedAt: String?
    var finishedAt: String?
    var code: Int?
    var summary: String?
}
struct RuntimeEntry: Decodable {
    var id: String
    var label: String
    var description: String?
    var detail: String?
    var status: String?
    var enabled: Bool?
    var cancellationSupported: Bool?
    var lastRun: RuntimeRun?
}
struct TodayTask: Decodable { var time: String; var title: String; var detail: String; var symbol: String }
struct TodayModel: Decodable { var name: String; var until: String; var covered: Bool; var phase: String }
struct TodayDashboard: Decodable {
    var date: String; var models: [TodayModel]; var tasks: [TodayTask]
    var todayStatus: String; var ended: String; var coverage: String
}
struct RuntimePlan: Decodable {
    var id: String; var name: String; var schedule: String; var status: String; var reason: String
    var manualTarget: String?; var dueAt: String?; var lastAt: String?; var note: String
    var controlId: String?
    var logDate: String?
}
func planStatus(_ status: String) -> String {
    ["SUCCESS":"成功", "FAILED":"失败", "RUNNING":"执行中", "PENDING":"待执行", "UNKNOWN":"待核实", "IDLE":"无记录", "PENDING_APPROVAL":"待确认"][status] ?? "待核实"
}
func businessIsTarget(_ id: String) -> Bool { businessTargets.contains(id) || id.hasPrefix("monitor/") }
func businessCanRunPlan(_ target: String, state: RuntimeEnvelope?, controls: [RuntimeControl], ready: Bool) -> Bool {
    ready && state?.usable() == true && state?.snapshot?.schedulerBusy != true && state?.snapshot?.plans?.contains(where: { $0.manualTarget == target }) == true &&
        !controls.contains(where: { $0.unsettled }) && !(state?.snapshot?.plans?.contains(where: { $0.status == "RUNNING" }) ?? true)
}
struct RuntimeSnapshot: Decodable {
    var services: [RuntimeEntry]
    var jobs: [RuntimeEntry]
    var operations: [RuntimeEntry]?
    var todayOverview: String?
    var dashboard: TodayDashboard?
    var plans: [RuntimePlan]?
    var schedulerBusy: Bool?
}
struct RuntimeEnvelope: Decodable {
    var available: Bool
    var receivedAt: String?
    var snapshot: RuntimeSnapshot?
    func usable(now: Date = Date()) -> Bool {
        guard available, snapshot != nil, let date = runtimeDate(receivedAt) else { return false }
        return now.timeIntervalSince(date) >= -30 && now.timeIntervalSince(date) < 120
    }
}
struct RuntimeControl: Decodable {
    var controlId: String
    var op: String
    var targetId: String
    var status: String
    var reason: String?
    var code: Int?
    var createdAt: Double
    var updatedAt: Double?
    var pending: Bool { ["AWAITING_PERMISSION", "PENDING_APPROVAL"].contains(status) }
    // Unknown/interrupted outcomes block another write until reviewed locally.
    var unsettled: Bool { !["COMPLETED", "FAILED", "REFUSED", "REJECTED", "TIMEOUT", "CANCELLED", "REVIEWED"].contains(status) }
    var cancellable: Bool { pending || ["DISPATCHED", "RUNNING"].contains(status) }
}
let businessTargets = ["scheduler", "daily", "allupdate"]
func businessLabel(_ id: String) -> String {
    id.hasPrefix("monitor/") ? String(id.dropFirst(8)) + " 订单监控" : ["scheduler": "Scheduler", "daily": "每日数据与日报", "allupdate": "Full data update"][id] ?? id
}
func runtimeStatus(_ status: String) -> String {
    ["ONLINE": "运行中", "OFFLINE": "已停止", "IDLE": "尚未运行", "RUNNING": "执行中",
     "DISPATCHED": "已提交", "AWAITING_PERMISSION": "待确认", "PENDING_APPROVAL": "待确认",
     "COMPLETED": "执行结束", "FAILED": "执行失败", "REFUSED": "操作被拒绝", "REJECTED": "已拒绝",
     "TIMEOUT": "已超时", "CANCELLED": "已取消", "UNKNOWN": "结果未知",
     "INTERRUPTED": "执行中断，待核验", "CANCELLING": "正在取消", "REVIEWED": "已解除阻塞", "UNCERTAIN": "结果待核验"][status] ?? "状态未知（\(status)）"
}
func runtimeDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = format.date(from: text) { return date }
    format.formatOptions = [.withInternetDateTime]
    return format.date(from: text)
}
func runtimeTime(_ text: String?) -> String {
    guard let date = runtimeDate(text) else { return text ?? "暂无记录" }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "MM-dd HH:mm:ss"
    return formatter.string(from: date)
}

func businessCanSubmit(_ id: String, op: String, state: RuntimeEnvelope?, controls: [RuntimeControl], ready: Bool) -> Bool {
    guard ready, state?.usable() == true, let snapshot = state?.snapshot,
          businessTargets.contains(id), !controls.contains(where: { businessIsTarget($0.targetId) && $0.unsettled }) else { return false }
    let entries = snapshot.jobs + (snapshot.operations ?? [])
    let running = entries.contains { ["daily", "allupdate"].contains($0.id) && $0.lastRun?.status == "RUNNING" }
    if running && op != "down" { return false }
    if id == "scheduler" {
        guard let service = snapshot.services.first(where: { $0.id == id }) else { return false }
        return op == "up" ? service.status == "OFFLINE" : ["down", "restart"].contains(op) && service.status == "ONLINE"
    }
    return op == "run" && entries.first(where: { $0.id == id }).map { $0.enabled != false } == true
}

enum RuntimeFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class LocalRuntimeClient {
    let root: String
    let python: String
    let serviceRoot: String
    var stateDirectory: String { root + "/.artifacts/business-runtime" }
    init(root: String, python: String, serviceRoot: String) {
        self.root = root; self.python = python; self.serviceRoot = serviceRoot
    }
    func request<T: Decodable>(_ action: String, body: [String: Any]? = nil, completion: @escaping (Result<T, Error>) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let result: Result<T, Error>
            do {
                let process = Process(), output = Pipe()
                process.executableURL = URL(fileURLWithPath: self.python)
                let payload = String(data: try JSONSerialization.data(withJSONObject: body ?? [:]), encoding: .utf8)!
                process.arguments = [self.root + "/scripts/business_runtime.py", "--service-root", self.serviceRoot,
                                     "--state-dir", self.stateDirectory, action, payload]
                process.environment = ["HOME": NSHomeDirectory(), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                                       "PYTHONUNBUFFERED": "1"]
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = output; process.standardError = output
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
                if process.terminationStatus != 0 {
                    let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
                    throw RuntimeFailure.message(message ?? String(data: data, encoding: .utf8) ?? "本机控制层没有返回有效结果")
                }
                result = .success(try JSONDecoder().decode(T.self, from: data))
            } catch { result = .failure(error) }
            DispatchQueue.main.async { completion(result) }
        }
    }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

private final class RuntimeCanvas: NSView {
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        if let stack = subviews.first as? NSStackView {
            let height = stack.fittingSize.height + 52
            if abs(frame.height - height) > 1 { setFrameSize(NSSize(width: frame.width, height: height)) }
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill(); NSBezierPath(rect: dirtyRect).fill()
    }
}

private final class PlanStatusTag: NSView {
    private let tint: NSColor

    init(label: NSTextField, tint: NSColor) {
        self.tint = tint
        super.init(frame: .zero)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        tint.withAlphaComponent(0.20).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
    }
}

final class BusinessRuntimeWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let client: LocalRuntimeClient
    private var snapshot: RuntimeEnvelope?
    private var controls: [RuntimeControl] = []
    private var polling = false, submitting = false, connected = false
    private let preview: Bool
    private var watching = Set<String>()
    private let connection = NSTextField(wrappingLabelWithString: "正在读取本机状态…")
    private let feedback = NSTextField(wrappingLabelWithString: "")
    private let planTable = NSTableView(), table = NSTableView()
    private let approve = NSButton(title: "确认所选操作", target: nil, action: nil)
    private let cancel = NSButton(title: "取消所选操作", target: nil, action: nil)
    private let review = NSButton(title: "已核验，解除阻塞", target: nil, action: nil)
    private let detail = NSTextField(wrappingLabelWithString: "选择执行记录查看详情。")
    private let refreshButton = NSButton(title: "刷新", target: nil, action: nil)
    private var actionButtons: [NSButton] = []
    private var historyWindow: NSWindowController?
    private var plans: [RuntimePlan] { snapshot?.snapshot?.plans ?? [] }
    private var available: Bool { !preview && connected && snapshot?.usable() == true && !polling && !submitting }
    private var selected: RuntimeControl? { controls.indices.contains(table.selectedRow) ? controls[table.selectedRow] : nil }
    var previewActionsDisabled: Bool { !available && !approve.isEnabled && !cancel.isEnabled && !review.isEnabled }

    init(root: String, python: String, serviceRoot: String, preview: Bool = false) {
        self.preview = preview; client = LocalRuntimeClient(root: root, python: python, serviceRoot: serviceRoot)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 430),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = preview ? "业务运行 · 界面预览（模拟数据）" : "业务运行 · Mashang"
        window.minSize = NSSize(width: 880, height: 360); window.isReleasedWhenClosed = false; window.center()
        build()
        if preview { loadPreview() } else { refresh() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func label(_ value: String, size: CGFloat = 13, bold: Bool = false) -> NSTextField {
        let text = NSTextField(wrappingLabelWithString: value)
        text.font = .systemFont(ofSize: size, weight: bold ? .semibold : .regular); return text
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views); stack.orientation = .horizontal; stack.spacing = 10; stack.alignment = .centerY; return stack
    }
    private func stack(in view: NSView) -> NSStackView {
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 14
        root.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            root.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            root.topAnchor.constraint(equalTo: view.topAnchor, constant: 18), root.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -18)])
        return root
    }
    private func full(_ view: NSView, in root: NSStackView) { root.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
    private func build() {
        let root = stack(in: window!.contentView!)
        refreshButton.target = self; refreshButton.action = #selector(refresh)
        let logs = NSButton(title: "调度日志", target: self, action: #selector(showLogs))
        full(row([label("业务运行", size: 21, bold: true), NSView(), refreshButton, logs]), in: root)
        connection.font = .systemFont(ofSize: 12); connection.textColor = .secondaryLabelColor; full(connection, in: root)
        for (id, title, width) in [("name", "Plan", 190.0), ("schedule", "运行计划", 220.0), ("state", "最近执行状态", 340.0), ("action", "操作", 110.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id)); column.title = title; column.width = width
            planTable.addTableColumn(column)
        }
        planTable.dataSource = self; planTable.delegate = self; planTable.rowHeight = 76
        planTable.columnAutoresizingStyle = .uniformColumnAutoresizingStyle; planTable.usesAlternatingRowBackgroundColors = true
        planTable.selectionHighlightStyle = .none
        let scroll = NSScrollView(); scroll.documentView = planTable; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        full(scroll, in: root); scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
        feedback.font = .systemFont(ofSize: 12); feedback.textColor = .secondaryLabelColor; full(feedback, in: root)
        let history = NSButton(title: "执行记录与审批…", target: self, action: #selector(showHistory))
        full(row([history, NSView(), label("手动刷新 · 不自动补执行", size: 11)]), in: root)
        update()
    }
    @objc private func showHistory() {
        if historyWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0,y: 0,width: 900,height: 470), styleMask: [.titled,.closable,.resizable], backing: .buffered, defer: false)
            window.title = "执行记录与审批"; window.isReleasedWhenClosed = false; window.minSize = NSSize(width: 820,height: 430); window.center()
            historyWindow = NSWindowController(window: window)
            let root = stack(in: window.contentView!)
            var buttons: [NSView] = [label("Scheduler", bold: true)]
            for (title, op) in [("启动", "up"),("停止", "down"),("重启", "restart")] {
                let button = NSButton(title: title, target: self, action: #selector(schedulerAction(_:)))
                button.identifier = NSUserInterfaceItemIdentifier(op); actionButtons.append(button); buttons.append(button)
            }
            buttons += [NSView(), NSButton(title: "业务目录", target: self, action: #selector(configure)), NSButton(title: "查看所选日志", target: self, action: #selector(historyLogs))]
            full(row(buttons), in: root)
            for (id,title,width) in [("target","对象 / 操作",310.0),("status","状态",180.0),("time","提交时间（上海）",220.0)] {
                let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id)); column.title = title; column.width = width; table.addTableColumn(column)
            }
            table.dataSource = self; table.delegate = self; table.rowHeight = 28; table.usesAlternatingRowBackgroundColors = true
            let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
            full(scroll, in: root); scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
            approve.target = self; approve.action = #selector(approveSelected); cancel.target = self; cancel.action = #selector(cancelSelected)
            review.target = self; review.action = #selector(reviewSelected)
            full(row([approve,cancel,review]), in: root); full(detail,in:root)
        }
        historyWindow?.showWindow(nil); table.reloadData(); update()
    }
    private func canRun(_ plan: RuntimePlan) -> Bool {
        guard let target = plan.manualTarget else { return false }
        return businessCanRunPlan(target, state: snapshot, controls: controls, ready: available)
    }
    private func update() {
        planTable.reloadData()
        refreshButton.isEnabled = !polling && !submitting && !preview
        approve.isEnabled = available && selected?.pending == true && !controls.contains { $0.unsettled && !$0.pending }
        cancel.isEnabled = available && selected?.cancellable == true && (selected?.pending == true || selected?.op == "run")
        review.isEnabled = available && selected?.status == "UNKNOWN"
        for button in actionButtons { button.isEnabled = businessCanSubmit("scheduler", op: button.identifier!.rawValue, state: snapshot, controls: controls, ready: available) }
        detail.stringValue = selected.map { "\($0.controlId)\n\(runtimeStatus($0.status)) · \($0.reason ?? "暂无附加信息")" + ($0.code.map { " · 退出码 \($0)" } ?? "") } ?? "暂无所选记录。可在此确认、取消或核验结果未知的操作。"
    }
    @objc func refresh() { reload() }

    private func reload(onSuccess: (() -> Void)? = nil) {
        guard !preview, !polling, !submitting else { return }
        polling = true; update()
        client.request("status") { [weak self] (result: Result<RuntimeEnvelope,Error>) in
            guard let self else { return }
            switch result {
            case .failure(let error): self.failedRefresh(error)
            case .success(let envelope):
                self.client.request("history") { [weak self] (result: Result<[RuntimeControl],Error>) in
                    guard let self else { return }; self.polling = false
                    switch result {
                    case .failure(let error): self.failedRefresh(error)
                    case .success(let values):
                        let selectedID = self.selected?.controlId
                        self.snapshot = envelope; self.controls = values; self.connected = true
                        let scheduler = envelope.snapshot?.services.first { $0.id == "scheduler" }?.status
                        let state = scheduler == "ONLINE" ? "运行中" : scheduler == "OFFLINE" ? "已停止" : "异常"
                        self.connection.stringValue = "Scheduler：\(state)  ·  最近刷新 \(runtimeTime(envelope.receivedAt))" + (envelope.usable() ? "" : " · 状态已过期，请刷新")
                        self.table.reloadData()
                        if let index = self.controls.firstIndex(where: { $0.controlId == selectedID }) { self.table.selectRowIndexes(IndexSet(integer:index),byExtendingSelection:false) }
                        self.update()
                        onSuccess?()
                        for control in values where ["DISPATCHED","RUNNING","CANCELLING"].contains(control.status) { self.watch(control) }
                    }
                }
            }
        }
    }
    private func failedRefresh(_ error: Error) {
        polling = false; connected = false
        connection.stringValue = "Scheduler：异常 · 状态读取失败，保留值不代表当前状态"
        feedback.stringValue = error.localizedDescription; update()
    }
    // Only track explicitly accepted local jobs; no periodic status/UI refresh.
    private func watch(_ control: RuntimeControl) {
        guard watching.insert(control.controlId).inserted, !preview else { return }
        client.request("wait", body:["controlId":control.controlId]) { [weak self] (result:Result<RuntimeControl,Error>) in
            guard let self else { return }; self.watching.remove(control.controlId)
            switch result {
            case .failure(let error): self.feedback.stringValue = "执行跟踪中断，请手动刷新：\(error.localizedDescription)"
            case .success(let current):
                if ["DISPATCHED","RUNNING","CANCELLING"].contains(current.status) { self.watch(current) }
                else { self.refresh() }
            }
        }
    }
    @objc private func runPlan(_ sender: NSButton) {
        guard !preview, !polling, !submitting, plans.indices.contains(sender.tag) else { return }
        let planID = plans[sender.tag].id
        if snapshot?.usable() != true || !connected {
            feedback.stringValue = "正在刷新状态…"
            reload { [weak self] in self?.confirmRun(planID) }
        } else {
            confirmRun(planID)
        }
    }
    private func confirmRun(_ planID: String) {
        guard let plan = plans.first(where: { $0.id == planID }), let target = plan.manualTarget,
              canRun(plan) else {
            feedback.stringValue = "该 Plan 当前不可运行。请查看执行状态或审批记录。"
            return
        }
        feedback.stringValue = ""
        let alert = NSAlert(); alert.messageText = "运行一次：\(plan.name)"
        alert.informativeText = plan.manualTarget == "daily" ? "刷新订单与线索、校验数据，并写入飞书多维表和发送日报。" : plan.manualTarget == "allupdate" ? "刷新全部本地数据集并校验。" : "刷新订单数据并发送该车型当前业务阶段的飞书监控消息。"
        alert.addButton(withTitle:"确认运行"); alert.addButton(withTitle:"取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard canRun(plan) else {
            feedback.stringValue = "状态已过期，请重新点击运行一次。"
            return
        }
        mutate("request",body:["targetId":target,"op":"run"],autoApprove:true)
    }
    @objc private func schedulerAction(_ sender:NSButton) {
        guard available, sender.isEnabled else { return }
        mutate("request",body:["targetId":"scheduler","op":sender.identifier!.rawValue])
    }
    private func mutate(_ action:String, body:[String:Any], autoApprove:Bool = false) {
        submitting = true; update()
        client.request(action,body:body) { [weak self] (result:Result<RuntimeControl,Error>) in
            guard let self else { return }; self.submitting = false
            switch result {
            case .failure(let error):
                self.feedback.stringValue = "\(error.localizedDescription)；请刷新记录核对，避免重复提交。"; self.connected = false; self.update(); self.refresh()
            case .success(let control):
                self.controls.removeAll { $0.controlId == control.controlId }; self.controls.insert(control,at:0)
                self.table.reloadData(); self.table.selectRowIndexes(IndexSet(integer:0),byExtendingSelection:false)
                if autoApprove { self.mutate("approve",body:["controlId":control.controlId]); return }
                self.feedback.stringValue = control.pending ? "操作已登记，请在执行记录中确认。" : "已受理，执行结果待返回。"
                self.update(); self.refresh()
                if ["DISPATCHED","RUNNING","CANCELLING"].contains(control.status) { self.watch(control) }
            }
        }
    }
    @objc private func approveSelected() {
        guard available, approve.isEnabled, let selected else { return }
        let alert = NSAlert(); alert.messageText = "确认执行 \(businessLabel(selected.targetId))"
        alert.informativeText = selected.targetId == "scheduler" ? "将改变调度器状态；停止或重启可能中断当前批次。" : "将运行现有业务入口，可能刷新本地数据并写入或发送飞书消息。"
        alert.addButton(withTitle:"确认执行"); alert.addButton(withTitle:"取消")
        if alert.runModal() == .alertFirstButtonReturn { mutate("approve",body:["controlId":selected.controlId]) }
    }
    @objc private func cancelSelected() {
        guard available, let selected, cancel.isEnabled else { return }; mutate("cancel",body:["controlId":selected.controlId])
    }
    @objc private func reviewSelected() {
        guard available, let selected, review.isEnabled else { return }
        let alert = NSAlert(); alert.messageText = "已核验本次执行结果？"
        alert.informativeText = "请先核验日志、数据和飞书送达结果。解除阻塞不会重跑任务，也不会把结果改为成功。"
        alert.addButton(withTitle:"已核验，解除阻塞"); alert.addButton(withTitle:"返回")
        if alert.runModal() == .alertFirstButtonReturn { mutate("review",body:["controlId":selected.controlId]) }
    }
    @objc private func configure() {
        let alert = NSAlert(); alert.messageText = "业务运行目录"
        alert.informativeText = "业务仓库：\(client.serviceRoot)\n运行记录：\(client.stateDirectory)"; alert.runModal()
    }
    @objc private func showLogs() { logs([:]) }
    @objc private func historyLogs() {
        logs(selected.map { ["controlId":$0.controlId] } ?? [:], parent: historyWindow?.window)
    }
    @objc private func planDetails(_ sender:NSButton) {
        guard plans.indices.contains(sender.tag) else { return }
        let plan = plans[sender.tag]
        var body:[String:Any] = ["targetId":plan.id]
        if let control = plan.controlId { body["controlId"] = control }
        else if let date = plan.logDate { body = ["date":date] }
        logs(body)
    }
    private func logs(_ body:[String:Any], parent: NSWindow? = nil) {
        guard !preview else { return }
        struct Log:Decodable {var text:String;var path:String}
        client.request("logs",body:body) { [weak self] (result:Result<Log,Error>) in
            guard let self else { return }
            let alert = NSAlert(); alert.messageText = "运行日志"
            let content:String
            switch result {
            case .success(let log): alert.informativeText = log.path; content = log.text
            case .failure(let error): alert.informativeText = "日志读取失败"; content = error.localizedDescription
            }
            let view = NSTextView(frame:NSRect(x:0,y:0,width:720,height:380)); view.isEditable = false
            view.string = content; view.font = .monospacedSystemFont(ofSize:11,weight:.regular)
            let scroll = NSScrollView(frame:view.frame); scroll.documentView = view; scroll.hasVerticalScroller = true
            view.isVerticallyResizable = true; view.autoresizingMask = [.width]; alert.accessoryView = scroll
            alert.addButton(withTitle:"关闭"); alert.beginSheetModal(for:parent ?? self.window!)
        }
    }
    func numberOfRows(in tableView:NSTableView) -> Int { tableView === planTable ? plans.count : controls.count }
    func tableView(_ tableView:NSTableView,viewFor column:NSTableColumn?,row index:Int) -> NSView? {
        if tableView === planTable {
            let plan = plans[index]
            switch column?.identifier.rawValue {
            case "name": return label(plan.name,bold:true)
            case "schedule": return label(plan.schedule,size:12)
            case "action":
                let buttons = NSStackView(); buttons.orientation = .vertical; buttons.alignment = .leading; buttons.spacing = 2
                if plan.manualTarget != nil {
                    let run = NSButton(title:"运行一次",target:self,action:#selector(runPlan(_:))); run.tag = index; run.isEnabled = canRun(plan); buttons.addArrangedSubview(run)
                } else { buttons.addArrangedSubview(label("不可手动运行",size:11)) }
                let logs = NSButton(title:"查看日志",target:self,action:#selector(planDetails(_:))); logs.tag = index; logs.bezelStyle = .recessed; buttons.addArrangedSubview(logs)
                return buttons
            default:
                let view = NSStackView(); view.orientation = .vertical; view.alignment = .leading; view.spacing = 3
                let own = controls.first { $0.targetId == plan.id && $0.unsettled }
                let state = own.map { $0.pending ? "PENDING_APPROVAL" : ["RUNNING","DISPATCHED","CANCELLING"].contains($0.status) ? "RUNNING" : "UNKNOWN" } ?? plan.status
                let status = label(planStatus(state), size: 12, bold: true)
                let statusView: NSView
                switch state {
                case "SUCCESS": statusView = PlanStatusTag(label: status, tint: .systemGreen)
                case "FAILED": statusView = PlanStatusTag(label: status, tint: .systemRed)
                default: statusView = status
                }
                let reason = label(own?.reason ?? plan.reason,size:11); reason.maximumNumberOfLines = 1
                reason.lineBreakMode = .byTruncatingTail; reason.toolTip = plan.reason
                let evidence = plan.dueAt.map { "应执行 " + runtimeTime($0) } ?? plan.lastAt.map { "最近记录 " + runtimeTime($0) } ?? plan.note
                let stamp = label(evidence,size:10); stamp.textColor = .secondaryLabelColor
                view.toolTip = "\(plan.reason)\n\(plan.note)\n" + (plan.lastAt.map { "最近记录：" + runtimeTime($0) } ?? "暂无记录")
                view.addArrangedSubview(statusView); view.addArrangedSubview(reason); view.addArrangedSubview(stamp); return view
            }
        }
        let control = controls[index]
        let value = column?.identifier.rawValue == "target" ? businessLabel(control.targetId) + " · " + control.op : column?.identifier.rawValue == "status" ? runtimeStatus(control.status) : runtimeTime(ISO8601DateFormatter().string(from:Date(timeIntervalSince1970:control.createdAt/1000)))
        return label(value,size:12)
    }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { tableView !== planTable }
    func tableViewSelectionDidChange(_ notification:Notification) { if notification.object as? NSTableView === table { update() } }
    private func loadPreview() {
        let now = ISO8601DateFormatter().string(from:Date())
        snapshot = RuntimeEnvelope(available:true,receivedAt:now,snapshot:RuntimeSnapshot(services:[RuntimeEntry(id:"scheduler",label:"Scheduler",status:"ONLINE")],jobs:[],operations:[],plans:[
            RuntimePlan(id:"daily",name:"每日数据与日报",schedule:"每天 08:50",status:"UNKNOWN",reason:"今日缺少完成证据",manualTarget:"daily",dueAt:"2026-11-05T08:50:00+08:00",lastAt:"2026-11-02T08:50:01+08:00",note:""),
            RuntimePlan(id:"monitor/LS8Neo",name:"LS8Neo 订单监控",schedule:"每天 08:50；关键日 20:00 / 21:00 / 22:00 / 23:00",status:"SUCCESS",reason:"模拟监控结果",manualTarget:"monitor/LS8Neo",note:"监控截至 2026-11-30"),
            RuntimePlan(id:"allupdate",name:"Full data update",schedule:"手动执行",status:"FAILED",reason:"dataset_validate 退出码 2",manualTarget:"allupdate",lastAt:"2026-11-04T10:10:00+08:00",note:"")]))
        connection.stringValue = "Scheduler：运行中 · 模拟预览 · 全部生产操作禁用"
        feedback.stringValue = "模拟数据，仅用于布局检查。"; update()
    }
}
