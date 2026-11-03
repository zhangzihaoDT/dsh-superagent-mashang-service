# Local runtime Git baseline

The repository already had a main branch, one initial research-prototype commit
(6337fc8), and origin https://github.com/zhangzihaoDT/dsh-superagent-prototype.git.
The local-runtime baseline preserves that history and adds the reviewed local
service, deployment and native menu-bar work. No history rewrite or remote push
is part of this baseline operation. Tag: v0.1.0-local-runtime.

Tracked boundaries: source, service/controller/build scripts, tests, dependency
lock, example configuration, setup and UI documentation. Runtime state, auth,
App bundles, logs, databases, PID/lock files, local environment and OS metadata
are ignored. No tracked credential store or runtime artifact was identified.
A scan of all existing commits and candidate files for common GitHub, AWS access
key and private-key signatures found no matches. This is a bounded inspection,
not a guarantee that every possible secret format is detected. No historical
files were removed. If a secret is later found, revoke/rotate it first and agree
on any history rewrite separately; do not silently rewrite published history.

Verification used a temporary source-only checkout, without the operator's
.artifacts directory; dependencies were reused from the local installed store.
Typechecking, all 1199 tests (including 17 service CLI cases), and bundle build
passed. The App built from an empty artifact directory, passed ad-hoc signature
verification and UI state/menu/icon checks. No fresh dependency download, new
macOS account setup, or actual login cycle was performed in this audit.

Fresh-machine steps and known reproducibility limits are in
[009 Local runtime setup](009-local-runtime-setup.md). The new UI spec is numbered
010 to avoid colliding with the original 007 Architecture document. No existing
tracked architecture documentation was replaced.

Operational validation is read-only: launchd service PID and health must match
before and after Git operations. Do not restart the service for Git maintenance.
Keep private, encrypted backups of runtime state and credentials separately;
Git stores reproducible code, not authenticated sessions or the live database.
Review diff and ignored-file boundaries before each commit. Never force-add
runtime files. Review repository visibility and history before any future push.
