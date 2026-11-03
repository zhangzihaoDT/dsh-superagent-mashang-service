# DSH SuperAgent — UI Design Spec v1.0

Scope: native macOS menu-bar controller.

## Principles

Native First, Status First, Action Hierarchy, Minimal Interaction, Safe Operations,
and Decoupled Runtime. Use system fonts, native menu layout and keyboard behavior.
Console actions precede service management; diagnostics follow management.

Use NSStatusItem, NSMenu and NSMenuItem. Use a monochrome Template whale in the
menu bar and retain the #174A7C App icon. Express state with both text and symbols.
Normal status must not use disabled low-contrast text. Do not use emoji, spacing
characters for layout, custom selection colors, or third-party UI frameworks.
Prefer simpler native presentation over custom popovers.

## States and interaction

- Ready: 运行正常. Open console, restart, stop.
- Starting: 正在启动. Show progress and prevent duplicate startup/restart.
- Paused: 服务暂停. Preserve actual state and available recovery operations.
- Stopped: 服务已停止. Offer start; disable console.
- Error: 服务异常. Prioritize diagnostic access and recovery operations.

State descriptions must match health checks. Failed checks do not imply stopped
processes. Operation failures must report reasons and provide logs. Refresh every
15 seconds, with manual refresh. Run CLI subprocesses off the main thread and
serialize operations. Clicking the enabled status row opens status details.

All lifecycle operations use the existing unified CLI. Quitting the controller
leaves the backend running. UI work must not change launchd, CLI, Runtime,
profiles, or process management.

## Acceptance

Verify light/dark contrast, consistent state text and symbols, appropriate action
visibility/enabling, no duplicated actions, native keyboard navigation, responsive
menus, CLI reuse, and service survival after UI exit. Distinguish automated
state/menu checks from actual desktop GUI verification in delivery reports.

## Menu icons

All actionable items use `NSMenuItem.image` with native SF Symbols:

| Menu item | Symbol |
| --- | --- |
| 打开控制台 | arrow.up.right.square |
| 启动服务 | play.fill |
| 停止服务 | stop.fill |
| 重启服务 | arrow.clockwise |
| 刷新状态 | arrow.triangle.2.circlepath |
| 查看状态详情 | info.circle |
| 打开日志目录 | folder |
| 高级选项 | gearshape |
| 退出控制器 | rectangle.portrait.and.arrow.right |

Images use a 16pt box, 14pt regular symbol configuration and template rendering.
System appearance and selection colors control their display; no custom text
indentation or submenu arrow is drawn. The submenu's native arrow is unchanged.
An unavailable symbol falls back to gearshape, then the system action template.
An unavailable image never removes or disables the associated action.

State icons use the same sizing and rendering: Ready uses checkmark.circle,
Starting/active lifecycle operations arrow.triangle.2.circlepath, Paused
pause.circle, Stopped stop.circle, Error exclamationmark.triangle, and the initial
status check clock. Status-row text and icon always express state together.
The menu-bar whale remains a separate 20pt Template Image; the colorful App icon
is unaffected.
