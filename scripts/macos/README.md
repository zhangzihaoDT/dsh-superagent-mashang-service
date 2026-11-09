Icon artwork uses the official DSH whale path from @deepseek-ai/dsh-web-frontend 0.2.1-rc.3 dist/favicon.svg (preserved as dsh-whale.svg). AppKit renders it in #174A7C on a white macOS tile.

UI v2 uses a separate transparent WhaleTemplate.png rendered from the same vector,
marked isTemplate at runtime (20pt). The colorful #174A7C App icon is unchanged.
The menu uses native NSMenu sections, state-driven service actions and an Advanced
submenu. All operations still invoke scripts/dsh-superagent; no service backend
changes are required. Status and lifecycle subprocesses run off the main thread.
Run the built Contents/MacOS/SuperAgent --test-states to exercise state mapping
and native menu structure without starting or stopping the service.

## Business runtime window (v2.2)

The menu's **业务运行控制** opens a native AppKit window for Scheduler,
Daily pipeline and Full data update, independent of DSH service health.
The app invokes `scripts/business_runtime.py` locally. No mashang-hub API,
Mac Worker, Agent session, network login or Hub credential is required.
Business code and credentials stay in mashang-service.

- Scheduler: inspect, start, stop and restart the existing sales scheduler
  through a local LaunchAgent supervisor with saved series and phase arguments. Its daily time is read from business source (currently 08:50); key-day
  rules remain in business configuration. This does not add another scheduler.
- Daily pipeline: `make -j1 data-pipeline`, ordered refresh → validate → daily
  observation sync, including Feishu table writes and report publication.
  Full data update: `make -j1 allupdate`, full refresh → validate.
- A fixed target/operation allowlist prevents arbitrary shell commands. The
  configured repository must contain the expected Makefile, scheduler and Python.
  Scheduler process identity includes the interpreter, script and working directory.
- Read status and history when opening the window, clicking Refresh, and after a submitted operation. Failed,
  missing or >120-second-old snapshots disable operations. Opening the UI only
  reads process state and logs; it never starts a business task.
- Clicking an action creates a pending local record. Selecting and confirming it
  launches a detached supervisor. Closing the window or quitting the controller
  does not stop it. Running manual pipelines support cancellation of their child
  process group; previous data writes are not rolled back. Timeout is 30 minutes.
- Persist requests, timestamps, exit codes, errors and log files under
  `.artifacts/business-runtime` in this checkout. New app sessions reload history;
  missing supervisors become UNKNOWN and block another app operation until the
  user checks the result and explicitly clears the block. No automatic retry.
- Show the latest scheduled daily batch from existing Scheduler logs, separately
  from manual operation history. **查看日志** opens the selected operation's log,
  or the latest Scheduler log when nothing is selected. Older Hub control records
  are not imported.

Build configuration binds the repository with `--service-root /absolute/path`
(default `~/Documents/github/mashang-service`). **业务目录** shows the binding and
local record directory. The app remains tied to this DSH checkout, as do its
existing DSH service controls. The current macOS user and the business repository's
existing credentials determine production write access.

### Existing limits and gradual Hub retirement

The app serializes its approved operations and checks for an active Scheduler
batch before manual execution. It does not establish an atomic lock with every
legacy trigger. Avoid submitting the same write from Hub/Feishu simultaneously.
Existing Feishu manual triggers and exception follow-up remain unchanged; Agent
participation is not required for these three native runtime controls.

Scheduler settings are persisted under `.artifacts/business-runtime/scheduler-settings.json`.
A previous process or launch record supplies a proposal that must be saved before
starting. The main window exposes start/stop and settings, and shows paused
schedules, configured coverage, next scheduled time and supervisor heartbeat.
The supervisor heartbeat proves supervisor liveness, not downstream delivery.

The managed LaunchAgent uses a repository-specific label and an inherited lock
under the business repository's `logs/scheduler`. It waits 30 seconds after a child
exit before retrying, waits for surviving batch processes, and preserves explicit
stop intent. Stop signals only the scheduler and allows its current batch to finish.
After 30 minutes the control operation reports an unconfirmed stop without killing
business work. The current scheduler's existing SIGTERM handler supplies graceful
shutdown. Legacy processes started outside this controller are detected before
startup, but do not participate in its lock.

“登录后自动恢复” writes the agent to `~/Library/LaunchAgents`. With this setting off,
the agent is registered only for the current login session using a plist in the
state directory. Enabling recovery preserves an intentional stopped state. This
is login recovery, not execution before login or while the computer is powered off.
The scheduler still has no durable missed-run recovery or automatic batch replay.
Command completion is not proof of Feishu delivery: existing business scripts
can return zero for some downstream failures. The UI says “执行结束”, not
“日报发布成功”. This feature moves operation ownership into the app; it does not
claim that all mashang-hub responsibilities are retired.

### Local validation without production side effects

```sh
python3 -m unittest discover -s tests -p '*_test.py' -v
python3 scripts/build-macos-app
".artifacts/DSH SuperAgent.app/Contents/MacOS/SuperAgent" --test-states
".artifacts/DSH SuperAgent.app/Contents/MacOS/SuperAgent" --test-business
".artifacts/DSH SuperAgent.app/Contents/MacOS/SuperAgent" --preview-runtime
```

Python tests execute harmless temporary Makefiles to verify detached execution,
failure, cancellation, conflict prevention and interrupted-record recovery. An additional temporary-repository LaunchAgent crash/restart, graceful-stop and session-reload test runs when
`DSH_TEST_NATIVE_PROCESSES=1` is set and macOS process probing is permitted. Native
tests check availability, stale state and action guards. `--preview-runtime` uses
fixture data, disables all write controls and invokes no business scripts.
Optional `--capture /absolute/path.png` renders the native view to a PNG and exits;
`--dark` captures Dark Aqua.

### Today's business processes

The window shows an automatically refreshed daily business overview before the runtime
controls. Phase windows use the canonical `utils/monitors/phase.py` read-only
functions and business_definition.json. Display active presale/launch windows,
launch-day events, recently ended windows, today's key-day times and whether a
daily batch has logs. Process `--series` / `--phase` arguments determine actual
coverage; Saved settings determine startup coverage when no scheduler is running; legacy defaults are labeled until settings are confirmed.
Business activity, process availability and verified execution are separate facts.

The business page now presents four summary metrics and a structured today-task
timeline before compact runtime controls and history. Task rows reflect configured
key-day hours. Future slots are pending; elapsed slots without execution evidence
remain unverified. The entire page scrolls without requiring a tall display.

### Compact Plan console

The main window shows one row per managed Plan. Scheduler controls and settings are on the main window. Logs, execution records
and approvals remain accessible from secondary windows.
Scheduled results refer to the latest due slot. Report and monitor success
require business evidence in addition to command completion. A missing receipt
is unverified. The existing monitor-sync target is available for an active,
validated model identifier. Approved local operations are watched for completion
alongside periodic main-window refresh.
