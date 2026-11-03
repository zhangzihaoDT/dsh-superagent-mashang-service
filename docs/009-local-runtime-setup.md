# Reproduce the local macOS runtime

This repository tracks source, templates and dependency locks. `.artifacts/` is
machine-local and must be regenerated, not copied from another operator. The
macOS controller uses AppKit and requires Xcode Command Line Tools. Runtime
prerequisites: Node 22.19+ or 24+, pnpm (packageManager in package.json), Python
3.8+, git 2.32+, GitHub CLI 2.48+. Homebrew is optional; tmux is needed only for
the legacy, non-launchd deployment. Keep the checkout at a stable path.

## Fresh Mac (do not run profile creation on an existing installation)

Install prerequisites and `xcode-select --install`, clone the repository, then:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p .artifacts/superagent-setup/runtime
npm install --prefix .artifacts/superagent-setup/runtime @deepseek-ai/dsh@0.2.1-rc.3
export DSH_HOME="$PWD/.artifacts/superagent-setup/dsh-home"
mkdir -p "$DSH_HOME"
chmod 700 "$DSH_HOME"
./.artifacts/superagent-setup/runtime/node_modules/.bin/dsh superagent --from-default-profile web --dump-config > /dev/null
./.artifacts/superagent-setup/runtime/node_modules/.bin/dsh plugin --profile superagent add "link:$PWD"
cp examples/profile.cordis.patch.yml "$DSH_HOME/profiles/superagent/cordis.patch.yml"
```

Edit the copied template: replace stateDir with the absolute path
`<checkout>/.artifacts/superagent-setup/dsh-home/state/superagent`; keep the
webserver on 127.0.0.1:3082. Never replace an existing profile on upgrades.
Configure a model provider in this isolated DSH home, using DSH's account/settings
flow; do not copy personal credentials or commit credentials into this repository.

Follow SETUP.md for repository/account/allowed-list choices and Accounts in
006-deployment.md for a dedicated `gh-agent` wrapper and interactive login.
The wrapper and its GH_CONFIG_DIR must be outside version control (for example,
under `.artifacts/superagent-setup/`). Do not put secrets in shell history or chat.

```sh
./scripts/dsh-superagent install
./scripts/dsh-superagent status
./scripts/build-macos-app
".artifacts/DSH SuperAgent.app/Contents/MacOS/SuperAgent" --test-states
pnpm check
```

Install is launchd-only and starts the service. Initial status may exit 3 until
Sources/Policy/Executor and prompts are saved via the panel/API as described in
006-deployment.md. Use that document's Management API to pause execution before
adding allowed users; retain observe mode and confirm a safe test before resuming.
Install refuses an existing service; migration instructions are in 006-deployment.
Copy the built App to ~/Applications or /Applications. No terminal exports are
needed for subsequent CLI/App operations; installation embeds absolute paths.

## Reproducibility limits and recovery

Project dependencies use pnpm-lock.yaml. DSH is pinned to 0.2.1-rc.3, but its fresh
npm installation resolves transitive dependencies and is not bit-for-bit locked.
App builds require the local macOS SDK and use an ad-hoc signature. Source/build
reproduction does not reproduce external accounts, permissions or model access.
Fresh-Mac end-to-end login and real logout/login require operator verification.

Back up the ignored DSH home/state and agent credential configuration securely
before upgrades; Git alone does not restore runtime state. Stop gracefully before
copying the live SQLite database, or use SQLite's supported online backup tools.
Restore secrets privately. Rebuild the App and reinstall the LaunchAgent after
moving the checkout or changing the Python/Node installation path.

For routine development use a branch, pnpm check, build the App, and review the
diff before committing. Use scripts/dsh-superagent status for read-only health;
Git operations do not require service restarts. Do not commit `.artifacts/`, App
bundles, logs, locks, authentication stores or machine-specific plists.

## Repository boundary

The orchestration repository and the business target are distinct. Installing
this runtime or changing its Git origin must not change the GitHub Source's
business target: `zhangzihaoDT/mashang-service` for the current Mashang setup.
Keep that business clone/worktrees separate from this runtime checkout. Agent
runtime, control UI and orchestration changes belong here; automotive data,
metrics, ingestion/update jobs and analysis changes belong in mashang-service.
Do not copy business code/data into the orchestration repository or merge the
two repositories. Authorization to execute a task is not permission to relocate
its business implementation.
