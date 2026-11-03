import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareWorkspace, type PrepareProfile } from '../src/prepare/workspace.ts'

let root: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const repository = (): string => {
  const path = join(root, 'repo')
  mkdirSync(path)
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'agent@example.test')
  git(path, 'config', 'user.name', 'Test Agent')
  writeFileSync(join(path, 'README.md'), '# business repository\n')
  git(path, 'add', 'README.md')
  git(path, 'commit', '-q', '-m', 'initial')
  return path
}
const probe = (body: string, name = 'probe.mjs'): string => {
  const path = join(root, name)
  writeFileSync(path, body)
  return path
}
const profile = (repo: string, extra: Partial<PrepareProfile> = {}): PrepareProfile => ({
  version: 1, checkout: repo, dataRoot: repo, baseRef: 'HEAD', branchPrefix: 'agent/', fetch: false, clean: true, python: 'python3',
  freshness: {}, data: [], officialQueries: [], ...extra,
})
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prepare-')) })
afterEach(() => {
  for (const path of [join(root, 'work', 'ticket'), join(root, 'work', 'missing'), join(root, 'work', 'stale')]) {
    try { execFileSync('git', ['-C', join(root, 'repo'), 'worktree', 'remove', '--force', path], { stdio: 'ignore' }) } catch { /* Absent. */ }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('prepareWorkspace', () => {
  it('creates a clean worktree, copies declared data read-only and records its cutoff and freshness', async () => {
    const repo = repository()
    mkdirSync(join(repo, 'dataset'))
    writeFileSync(join(repo, 'dataset', 'orders.csv'), 'order_number,lock_time\nA,2026-11-02T10:00:00\nB,2026-11-03T00:58:00\n')
    const script = probe('let body="";process.stdin.on("data",c=>body+=c).on("end",()=>{const r=JSON.parse(body);console.log(JSON.stringify({rows:2,columns:["order_number","lock_time"],cutoffs:[{column:"lock_time",at:"2026-11-03T00:58:00"}]}))})')
    const ticket = { id: 'ticket-1', name: 'prepare-test', directory: join(root, 'work', 'ticket') }
    const recordPath = join(root, 'prepare.json')
    const now = new Date('2026-11-03T13:00:00+08:00')
    const result = await prepareWorkspace({ profile: profile(repo, {
      probe: { command: [process.execPath, script], timeoutMs: 30_000 },
      freshness: { maxAgeHours: 24 },
      data: [{ path: 'dataset/orders.csv', required: true, readOnly: true, notes: 'orders', cutoff: { columns: ['lock_time'], required: true } }],
      officialQueries: [{ id: 'orders', description: 'official orders', command: ['make', 'orders'], notes: '' }],
    }), ticket, recordPath, now })
    expect(result.record.status).toBe('ready')
    expect(result.record.worktree.clean).toBe(true)
    expect(result.record.source.clean).toBe(true)
    expect(result.record.data).toHaveLength(1)
    expect(result.record.data[0]).toMatchObject({ path: 'dataset/orders.csv', mode: 'clone', readOnly: true, rows: 2, columns: 2,
      cutoff: { at: '2026-11-03T00:58:00', column: 'lock_time' }, fresh: true })
    expect(statSync(join(ticket.directory, 'dataset', 'orders.csv')).mode & 0o222).toBe(0)
    expect(readFileSync(join(ticket.directory, 'dataset', 'orders.csv'), 'utf8')).toContain('2026-11-03T00:58:00')
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).status).toBe('ready')
    expect(result.record.officialQueries).toEqual([{ id: 'orders', description: 'official orders', command: ['make', 'orders'], notes: '' }])
  })

  it('uses the business repository\'s declaration command and merges explicit entries over it', async () => {
    const repo = repository()
    mkdirSync(join(repo, 'dataset'))
    writeFileSync(join(repo, 'dataset', 'orders.csv'), 'lock_time\n2026-11-03T00:58:00\n')
    const declare = probe('console.log(JSON.stringify([{path:"dataset/orders.csv",required:true,cutoff:{columns:["lock_time"]}}]))', 'declare.mjs')
    const script = probe('console.log(JSON.stringify({rows:1,columns:["lock_time"],cutoffs:[{column:"lock_time",at:"2026-11-03T00:58:00"}]}))', 'probe-2.mjs')
    const ticket = { id: 'ticket-2', name: 'declared', directory: join(root, 'work', 'ticket') }
    const result = await prepareWorkspace({ profile: profile(repo, {
      declare: { command: [process.execPath, declare], timeoutMs: 30_000 },
      probe: { command: [process.execPath, script], timeoutMs: 30_000 },
      data: [{ path: 'dataset/orders.csv', required: true, readOnly: true, notes: 'explicit', cutoff: { columns: ['lock_time'], required: true } }],
    }), ticket, recordPath: join(root, 'prepare.json'), now: new Date('2026-11-03T13:00:00+08:00') })
    expect(result.record.data).toHaveLength(1)
    expect(result.record.data[0]?.notes).toBe('explicit')
  })

  it('refuses a source checkout with uncommitted tracked changes and records the failure', async () => {
    const repo = repository()
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    const ticket = { id: 'ticket-3', name: 'dirty', directory: join(root, 'work', 'ticket') }
    const recordPath = join(root, 'prepare.json')
    await expect(prepareWorkspace({ profile: profile(repo), ticket, recordPath })).rejects.toThrow(/uncommitted tracked changes/)
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).status).toBe('failed')
    expect(readFileSync(recordPath, 'utf8')).toContain('uncommitted tracked changes')
  })

  it('refuses a profile that serves another repository', async () => {
    const repo = repository()
    await expect(prepareWorkspace({ profile: profile(repo, { repository: 'owner/one' }),
      ticket: { id: 'ticket-4', name: 'mismatch', directory: join(root, 'work', 'mismatch') },
      env: { ...process.env, DSH_SUPERAGENT_GITHUB_REPOSITORY: 'owner/two' } })).rejects.toThrow(/for owner\/one, but this ticket is for owner\/two/)
  })

  it('refuses a missing required data file and a stale cutoff', async () => {
    const repo = repository()
    const missing = { id: 'ticket-4', name: 'missing', directory: join(root, 'work', 'missing') }
    await expect(prepareWorkspace({ profile: profile(repo, { data: [{ path: 'dataset/missing.csv', required: true, readOnly: true,
      notes: '', cutoff: { columns: ['lock_time'], required: true } }] }), ticket: missing })).rejects.toThrow(/missing/)
    expect(existsSync(missing.directory)).toBe(false)
    expect(git(repo, 'branch', '--list', 'agent/missing')).toBe('')
    mkdirSync(join(repo, 'dataset'))
    writeFileSync(join(repo, 'dataset', 'orders.csv'), 'lock_time\n2026-11-01T00:00:00\n')
    const script = probe('console.log(JSON.stringify({rows:1,columns:["lock_time"],cutoffs:[{column:"lock_time",at:"2026-11-01T00:00:00"}]}))')
    await expect(prepareWorkspace({ profile: profile(repo, {
      probe: { command: [process.execPath, script], timeoutMs: 30_000 }, freshness: { maxAgeHours: 24 },
      data: [{ path: 'dataset/orders.csv', required: true, readOnly: true, notes: '', cutoff: { columns: ['lock_time'], required: true } }],
    }), ticket: { id: 'ticket-5', name: 'stale', directory: join(root, 'work', 'stale') }, recordPath: join(root, 'prepare.json'),
    now: new Date('2026-11-03T13:00:00+08:00') })).rejects.toThrow(/stale/)
  })
})
