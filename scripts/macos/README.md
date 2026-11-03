Icon artwork uses the official DSH whale path from @deepseek-ai/dsh-web-frontend 0.2.1-rc.3 dist/favicon.svg (preserved as dsh-whale.svg). AppKit renders it in #174A7C on a white macOS tile.

UI v2 uses a separate transparent WhaleTemplate.png rendered from the same vector,
marked isTemplate at runtime (20pt). The colorful #174A7C App icon is unchanged.
The menu uses native NSMenu sections, state-driven service actions and an Advanced
submenu. All operations still invoke scripts/dsh-superagent; no service backend
changes are required. Status and lifecycle subprocesses run off the main thread.
Run the built Contents/MacOS/SuperAgent --test-states to exercise state mapping
and native menu structure without starting or stopping the service.
