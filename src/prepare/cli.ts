/** Command-line entry for the workspace preparer: reads a workspace profile and prepares the current ticket. */
import { parseArgs } from 'node:util'
import { prepareWorkspace, PrepareError } from './workspace.ts'

const usage = `Usage: prepare-workspace --profile <file> | --profiles-dir <dir> [--record <file>] [--now <ISO>]

The ticket comes from DSH_SUPERAGENT_TICKET, DSH_SUPERAGENT_NAME and DSH_SUPERAGENT_DIR.
With --profiles-dir, the profile is selected by DSH_SUPERAGENT_GITHUB_REPOSITORY (owner__name.json), else default.json.
The record defaults to DSH_SUPERAGENT_PREPARE_RECORD, else <ticket>/.superagent/prepare.json.`

async function main(): Promise<number> {
  let values: ReturnType<typeof parseArgs>['values']
  try {
    ({ values } = parseArgs({ options: {
      profile: { type: 'string' },
      'profiles-dir': { type: 'string' },
      record: { type: 'string' },
      now: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    }, allowPositionals: false }))
  } catch (error) {
    console.error(`prepare-workspace: ${error instanceof Error ? error.message : String(error)}`)
    console.error(usage)
    return 2
  }
  if (values.help) { console.log(usage); return 0 }
  const option = (name: 'profile' | 'profiles-dir' | 'record' | 'now'): string | undefined => {
    const value = values[name]
    return typeof value === 'string' ? value : undefined
  }
  try {
    const profile = option('profile'), profilesDir = option('profiles-dir'), record = option('record'), now = option('now')
    const result = await prepareWorkspace({
      ...profile ? { profilePath: profile } : {},
      ...profilesDir ? { profilesDir } : {},
      ...record ? { recordPath: record } : {},
      ...now ? { now: new Date(now) } : {},
    })
    console.log(JSON.stringify({ ok: true, recordPath: result.recordPath, record: result.record }))
    return 0
  } catch (error) {
    const message = error instanceof PrepareError ? error.message : error instanceof Error ? error.message : String(error)
    console.error(`prepare-workspace: ${message}`)
    return 1
  }
}

process.exitCode = await main()
