/** Standalone Web plugin entry with an optional mount receipt for deployment checks. */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import s from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { installSkillRouting } from './skill-routing.ts'

// This entry can also be mounted by a standalone DSH Web profile.
export const name = 'dsh-superagent-skill-routing'
export const inject = ['skills']
export const Config = s.object({ receiptPath: s.string().pattern(/^\//) })
export function apply(ctx: Context, { receiptPath }: Partial<ReturnType<typeof Config>> = {}): void {
  installSkillRouting(ctx)
  if (!receiptPath) return
  const entry = realpathSync(fileURLToPath(import.meta.url))
  const launcher = realpathSync(process.argv[1]!)
  const dshVersion: string = JSON.parse(readFileSync(resolve(dirname(launcher), '../package.json'), 'utf8')).version
  const temporary = `${receiptPath}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({
      pid: process.pid, entry, dshVersion, mountedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    }) + '\n', { mode: 0o600 })
    renameSync(temporary, receiptPath)
  } finally {
    rmSync(temporary, { force: true })
  }
  ctx.effect(() => () => {
    // A successor may have written its receipt before the old plugin is disposed.
    try {
      if (JSON.parse(readFileSync(receiptPath, 'utf8')).pid === process.pid) rmSync(receiptPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })
}
