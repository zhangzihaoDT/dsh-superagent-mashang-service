# 013 Controlled production data jobs

This document records the audit and the minimal design that lets an authorized person refresh Mashang production data from Feishu or the DSH Web session without opening a terminal. It builds on [002 Authorization](002-authorization.md), [003 Execution](003-execution.md) and [011 Workspace preparation](011-workspace-prepare.md).

## Why the agent refused

Before this change, four independent layers prevented a production update:

1. **Worker prompt.** `prompts/work.md` said "No data updates, production jobs, repository writes or PRs." The saved team scope also said "Never modify production data, trigger formal data updates, run production jobs or deploy."
2. **No controlled tool.** The Executor had shell access but no registered business-job tool. The only safe-looking action was to ask the person to run `make data-refresh-daily` and `make data-status` in a terminal.
3. **Wrong directory.** Prepare creates a Ticket worktree from the clean checkout and copies declared data read-only. The worktree is for code and read-only queries, not the production checkout. Running `make` there would either fail or write into the wrong checkout.
4. **Sandbox and approval.** The worker's shell is `workspace-write` rooted at the DSH checkout, with approval `ask`. The production repository is outside that root. Even with the prompt relaxed, a direct shell write would be blocked or require an approval the Feishu flow could not complete.

The repository boundary is intentional: `mashang-service` owns business execution, while DSH-SuperAgent owns authorization, routing and delivery.

## Design

Two layers, each with one job:

| Layer | Owns | Does not own |
| --- | --- | --- |
| `mashang-service` `jobs/production.py` | Fixed job allowlist, production-root verification, cross-process lock, timeout, process-group termination, `make data-refresh-daily`, automatic `make data-status`, before/after dataset snapshots, JSON/JSONL logs | Who may ask, identity checks, chat routing |
| DSH-SuperAgent `src/app/business-jobs.ts` and `business_job` tool | Requester allowlist check, explicit-ticket check, job allowlist, direct execution, detached run and record recovery | Business command implementation, metric definitions, data files |

The only registered production job is `data-refresh-daily`:

```text
make -j1 data-refresh-daily   # order_data + assign_data, daily scope
make -j1 data-status          # automatic verification
```

No arbitrary command, shell string or user-supplied argv reaches either layer.

## Authorization and direct execution

The Source user allowlist is the execution authorization. A person on it may ask in Feishu or the DSH Web session to run a registered regular job; `data-refresh-daily` is such a job.

1. The person sends an explicit request such as “更新订单数据”.
2. The existing gate admits the explicit request and creates a Ticket.
3. The worker calls `business_job operation=run` with the request's `trigger_id`.
4. The tool checks that the Ticket is live and explicitly authorized, that the job is registered and marked `approval: 'none'`, and that the request is a human on the current Source allowlist.
5. The service job starts immediately. There is no second confirmation, no pending state and no confirmation code.

A failed, timed-out or busy job is never retried automatically. A job marked `approval: 'required'` is refused until a high-risk approval path is implemented; the `approval` field is the extension point, and no current job uses it.

The tool is registered only on Executor Sessions, not on the main Session. An unauthorized person is stopped by the Source gate; if a message nevertheless reaches a Ticket, the tool rechecks the actor and refuses. Repeating the request, quoting text or using another chat does not add authority.

## Execution safety

- **Production root.** `DSH_SUPERAGENT_BUSINESS_ROOT` names the production checkout, defaulting to `~/Documents/github/mashang-service`. The service job refuses a path whose `.git` is a file, which excludes linked worktrees and submodules. It also requires `Makefile`, `.venv/bin/python` and the dataset registry, and verifies `git rev-parse --show-toplevel`.
- **Lock.** An `fcntl` lock at `logs/production-jobs/data-refresh-daily.lock` blocks a second refresh across processes. A busy run returns `busy` with the holder's PID and start time.
- **Timeout.** The service job allows 30 minutes by default and terminates the whole `make` process group on timeout. The DSH tool waits up to 35 minutes for the service record.
- **Logs.** Each run writes `logs/production-jobs/records/<run-id>.json`, `latest.json`, `<run-id>.log` and `events.jsonl`. `logs/` is already ignored by the business repository.
- **Verification.** The service job snapshots `order_data` and `assign_data` before and after. It reports `success` only when a row count or data cutoff advanced. A successful refresh that produced no new records is `no_new_data`, not a failure. A data cutoff regression or row-count drop is `verification_failed`.
- **No worktree writes.** The service job validates the root before writing any log. A Ticket worktree gets no run record and no production write.
- **Early failure is inert.** A failure before the first command, such as an unreadable dataset registry, records `failed` with `commands: []` and writes no dataset. The latest data time is left unchanged.

## Result contract

The service job returns one JSON object with:

- `status`: `success`, `no_new_data`, `failed`, `timeout`, `verification_failed` or `busy`;
- `latest_data_time` and `latest_data_time_by_dataset`;
- `before` and `after` snapshots for the daily datasets;
- `changed_datasets`, `new_data`, `warnings`, `commands`, `log_path` and `record_path`;
- `summary`, an operator-readable one-line result.

The worker reports the user-visible result and the actual latest data time. It must not call a `no_new_data` run an update that produced new records.

## Safe testing

- `jobs/tests/test_production_job.py` uses temporary repositories and temporary Makefiles. It covers success, no new data, failure, timeout, worktree refusal and a second process holding the lock.
- `tests/business-jobs.spec.ts` uses a fake runner. It covers explicit-only authorization, allowlisted direct execution, inferred/unauthorized refusal, unknown-job refusal, status recovery and the detached launcher.
- `python -m jobs.production check data-refresh-daily --repo-root <path>` validates the production root without writing.
- Do not run the real `data-refresh-daily` in a test. A real run is a production write; the allowlisted request itself starts it, with no second confirmation.

## Operational notes

- The DSH service must be rebuilt and restarted after changing `src/`; prompt files are read from disk, but the `business_job` tool is registered by the built runtime.
- Existing Tickets keep the prompt revision they started under. Start a new Ticket, or let an existing one receive a new model request after the prompt revision changes, to use the new instructions.
- The production job is local to the Mac. A sleeping or offline Mac cannot execute it; the request remains a pending Ticket until a worker can run it.
- The first explicit request is the write. There is no separate confirmation step, so the allowlist and the job allowlist are the complete authorization boundary.
- The job refreshes local datasets only. It does not write Feishu tables and does not send cards. `make data-pipeline` and `make daily-ops` remain separate, higher-side-effect entries and are not registered here.
