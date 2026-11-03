# 011 Workspace preparation

`prepare-workspace` creates a Ticket's clean git worktree and supplies the business repository's shared data read-only. It records where the data came from, its cutoff and freshness, and how long preparation took. It runs as the configured `executor.prepare` command; [003 Execution](003-execution.md) describes when that command runs.

The Harness core contains no business repository path. A deployment describes each business repository in a workspace profile, and a repository declares its shared data in its own registry. One profile per repository lets the same mechanism serve future repositories.

## What preparation does

1. Resolves the profile from `--profile` or, with `--profiles-dir`, from `DSH_SUPERAGENT_GITHUB_REPOSITORY` as `<owner>__<name>.json` (falling back to `default.json`).
2. Checks that the source checkout is clean. Tracked uncommitted changes fail preparation, so a dirty main checkout is never the code execution environment. The checkout is read only; preparation never writes to it.
3. Resolves the data root, which may differ from the checkout. The data root is where the repository's gitignored data lives; it is a data source only, not an execution directory.
4. Reads the shared-data declaration, then creates a git worktree with a new `agent/<ticket-name>` branch from `baseRef`.
5. Copies each declared file into the worktree, preferring an APFS clone, and makes it read-only (`0444`). Data already tracked by git is left as checked out.
6. Probes each file's row count, columns and cutoff, and compares the cutoff with the profile's freshness limit.
7. Verifies that the worktree has no tracked changes, writes the prepare record, and returns.

A missing required file, a missing cutoff, a stale file, a dirty checkout, an existing branch or a non-empty ticket directory fails preparation with a message naming the file, path, cutoff and limit. [003 Execution](003-execution.md) describes how the Ticket shows that failure.

## A workspace profile

```json
{
  "version": 1,
  "repository": "owner/business-repository",
  "checkout": "/absolute/path/to/a/clean-checkout",
  "dataRoot": "/absolute/path/to/the/working-checkout-that-holds-the-data",
  "baseRef": "main",
  "branchPrefix": "agent/",
  "fetch": false,
  "clean": true,
  "python": "python3",
  "freshness": { "maxAgeHours": 24 },
  "declare": {
    "command": ["python3", "-c", "import json\nprint(json.dumps([{'path': 'dataset/order_data.parquet', 'required': True, 'cutoff': {'columns': ['lock_time']}}]))"],
    "timeoutMs": 60000
  },
  "officialQueries": [
    {
      "id": "launch-monitor",
      "description": "The repository's existing official read-only query entry.",
      "command": ["python3", "mashang_workspace/business_scripts/vehicle_sales_monitor.py", "--dry-run", "--format", "json"],
      "notes": "Add the requested filters; keep output under /tmp."
    }
  ]
}
```

`repository` is optional: when both the profile and the ticket name a GitHub repository, preparation refuses a mismatch. `checkout` and `dataRoot` are absolute paths supplied by the deployment. `fetch: true` runs `git fetch --no-tags origin` before resolving `baseRef`; otherwise the local checkout's ref is used. `clean` is true by default and refuses tracked changes.

### Declared shared data

The business repository declares its data, so the Harness does not keep a list of business files. `declare.command` runs in the clean checkout and prints a JSON array. Each item has:

| Field | Meaning |
| --- | --- |
| `path` | Repository-relative file path |
| `required` | Fail preparation when missing; defaults to true |
| `readOnly` | Copy as read-only; defaults to true |
| `maxAgeHours` | Override the profile's freshness limit |
| `cutoff.columns` | Columns whose latest value is the data cutoff |
| `cutoff.required` | Fail when no cutoff can be found; defaults to true |
| `notes` | Human-readable provenance |

The profile may also list `data` entries directly. Explicit entries override declared entries with the same path. `dataset/updater/dataset_registry.py` is the single source of truth for the current Mashang repository; its declaration command selects `order_data` and uses `lock_time` as its cutoff.

### The data probe

A probe receives one JSON request on stdin and prints one JSON object:

```json
{"path": "/absolute/file.parquet", "columns": ["lock_time"], "now": "2026-11-03T13:00:00+08:00"}
```

It prints `{"rows": 551347, "columns": ["..."], "cutoffs": [{"column": "lock_time", "at": "2026-11-03T00:58:03"}]}`. The bundled `scripts/probe-dataset.py` reads parquet and CSV with pandas and pyarrow. A profile may replace it with `probe.command`. The probe is read-only and has a timeout.

## The prepare record

Preparation writes one record to `DSH_SUPERAGENT_PREPARE_RECORD` (the Harness sets `<stateDir>/prepare/<ticket-id>.json`; a standalone run defaults to `<ticket-name>.prepare.json` beside the worktree). Its worker reads it before work. It holds:

- the ticket and its worktree, branch, head and clean status;
- the source repository, checkout, data root, base ref, base commit and whether the source was clean;
- for each file: source path, copy mode, byte size, mtime, SHA-256, rows, columns, cutoff column and time, age, limit and freshness;
- the official query entries the repository already provides;
- warnings for optional data;
- the timing of preparation, broken into inspect, worktree, data and verify phases.

Data copied into the worktree is a snapshot. A later refresh of the business data does not change a Ticket's snapshot, and the record states the snapshot's cutoff.

Copied files use the business repository's existing Git ignore rules; the helper does not add ignore patterns. Check each declared untracked file with `git check-ignore -v` during deployment acceptance. A clean tracked status alone does not prove that copied data is ignored.

Failed preparation removes the worktree it created, prunes its registration and deletes its branch. Successful Ticket worktrees and data snapshots are retained for follow-up work; there is no automatic age-based cleanup. After the Ticket has ended and its worker is idle, an operator can archive its prepare/timing records, remove that Ticket's worktree with `git worktree remove --force <directory>`, and delete only its temporary branch. Removing the worktree removes its copied data, leaving `dataRoot` intact. Keep audit records outside the worktree.

The profile's `maxAgeHours` is a limit for a read-only analysis snapshot. It does not replace a business monitor's own push freshness gate: when a production push runs, its stricter limit remains the authority, and a read-only answer states the cutoff it actually used.

## Read-only queries

The worker prompt tells a worker whose ticket only reads data to:

- read the prepare record and work only in `$DSH_SUPERAGENT_DIR`;
- use the declared data paths and the official query entry, once, with the requested scope;
- avoid searching the filesystem for datasets and switching checkouts;
- cross-validate with a second full computation only when the first result is empty, impossible, contradicts the definition, or definitions conflict;
- report only the conclusion, definition, data cutoff and necessary discrepancy;
- make no data update, production job, business repository write or pull request.

## Timing

The prepare record carries preparation time. The worker's Session also writes `<stateDir>/execution-timings/<ticket-id>.json`:

| Field | Meaning |
| --- | --- |
| `prepare` | The external prepare command's start, end and duration |
| `agent.modelMs` | Time from a step's start to the model's assistant message, summed |
| `agent.toolMs` | Time from a tool call to its result, summed |
| `agent.turnMs` | Turn start to turn end, summed |
| `total` | From preparation's start to the latest turn end |
| `commands` | Each shell command with duration and whether it looks like a script run |
| `outsideCds` | Commands that change into an absolute path outside the worktree |
| `parquetSearches` | Commands that look like a filesystem search for a dataset |
| `repeatedScripts` | A script command run more than once |

These records make before-and-after comparisons possible without changing Ticket state. The tool names and command text are diagnostic; they never fail a worker.

## Activation

Build the Harness, then set the executor's prepare command in the management panel or settings API, for example:

```sh
node "$DSH_SUPERAGENT_PREPARE_CLI" --profile "/absolute/path/to/workspace-profiles/mashang-service.json"
```

`DSH_SUPERAGENT_PREPARE_CLI` is the built `prepare-workspace` helper. With several business repositories, point the command at `--profiles-dir` and name each profile `<owner>__<name>.json`; the GitHub Source's repository selects it, and Feishu tickets fall back to `default.json`. Restart dsh-superagent after building so workers receive the new helper, prompt and execution variables.

The example profile is [examples/workspace-profiles/mashang-service.example.json](../examples/workspace-profiles/mashang-service.example.json). The live profile belongs with the deployment's other machine-local configuration, not with business code.

## Limits

The read-only copy and the clean-checkout check are operational guards, not an OS security boundary. A worker owns its files and can change permissions. The worktree is a snapshot; it does not guarantee that every repository script is safe to run. The official query entries and the read-only prompt remain the authority for what a worker should run.
