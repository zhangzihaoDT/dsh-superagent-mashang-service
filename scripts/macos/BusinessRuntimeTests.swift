import AppKit

func runBusinessRuntimeTests() {
    let now = Date()
    let empty = RuntimeSnapshot(services: [], jobs: [], operations: [])
    precondition(RuntimeEnvelope(available: true, receivedAt: ISO8601DateFormatter().string(from: now), snapshot: empty).usable(now: now))
    precondition(!RuntimeEnvelope(available: false, receivedAt: ISO8601DateFormatter().string(from: now), snapshot: empty).usable(now: now))
    precondition(!RuntimeEnvelope(available: true, receivedAt: ISO8601DateFormatter().string(from: now.addingTimeInterval(-121)), snapshot: empty).usable(now: now))
    precondition(!RuntimeEnvelope(available: true, receivedAt: nil, snapshot: empty).usable(now: now))
    precondition(!RuntimeEnvelope(available: true, receivedAt: "invalid", snapshot: empty).usable(now: now))
    precondition(!RuntimeEnvelope(available: true, receivedAt: ISO8601DateFormatter().string(from: now), snapshot: nil).usable(now: now))
    for status in ["RUNNING", "UNKNOWN", "INTERRUPTED", "UNCERTAIN", "AWAITING_PERMISSION"] {
        precondition(RuntimeControl(controlId: "x", op: "run", targetId: "daily", status: status, createdAt: 0).unsettled)
    }
    precondition(!RuntimeControl(controlId: "x", op: "run", targetId: "daily", status: "COMPLETED", createdAt: 0).unsettled)
    precondition(!RuntimeControl(controlId: "x", op: "run", targetId: "daily", status: "UNKNOWN", createdAt: 0).cancellable)
    let readySnapshot = RuntimeSnapshot(services: [RuntimeEntry(id: "scheduler", label: "Scheduler", status: "ONLINE")], jobs: [],
        operations: [RuntimeEntry(id: "daily", label: "Daily", enabled: true, lastRun: RuntimeRun(status: "IDLE")),
                     RuntimeEntry(id: "allupdate", label: "Full", enabled: false)])
    var state = RuntimeEnvelope(available: true, receivedAt: ISO8601DateFormatter().string(from: now), snapshot: readySnapshot)
    precondition(businessCanSubmit("daily", op: "run", state: state, controls: [], ready: true))
    precondition(!businessCanSubmit("scheduler", op: "up", state: state, controls: [], ready: true))
    precondition(businessCanSubmit("scheduler", op: "down", state: state, controls: [], ready: true))
    precondition(!businessCanSubmit("allupdate", op: "run", state: state, controls: [], ready: true))
    precondition(!businessCanSubmit("daily", op: "run", state: state, controls: [], ready: false))
    precondition(!businessCanSubmit("other", op: "run", state: state, controls: [], ready: true))
    let uncertain = RuntimeControl(controlId: "x", op: "run", targetId: "daily", status: "UNKNOWN", createdAt: 0)
    precondition(!businessCanSubmit("daily", op: "run", state: state, controls: [uncertain], ready: true))
    state.snapshot?.operations?[0].lastRun?.status = "RUNNING"
    precondition(!businessCanSubmit("daily", op: "run", state: state, controls: [], ready: true))
    precondition(businessCanSubmit("scheduler", op: "down", state: state, controls: [], ready: true))
    state.available = false
    precondition(!businessCanSubmit("scheduler", op: "down", state: state, controls: [], ready: true))
    _ = NSApplication.shared
    let preview = BusinessRuntimeWindow(root: "/preview", python: "/usr/bin/false", serviceRoot: "/preview/mashang-service", preview: true)
    precondition(preview.previewActionsDisabled)
    print("Business runtime UI: stale/unavailable status, active/uncertain operation guards and disabled offline preview checks passed")
}
