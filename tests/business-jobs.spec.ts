/** Direct production-job authorization and execution; no production job is started. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BUSINESS_JOBS, BusinessJobs, type BusinessJobRun } from '../src/app/business-jobs.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const NOW = Date.parse('2026-11-05T06:00:00Z')
const TRIGGER = 'trigger-1'
const FOLLOWUP = 'trigger-followup'

let directory = ''
const directories: string[] = []
afterEach(() => { for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true }); directory = '' })

function fixture(options: { allowed?: boolean; human?: boolean; now?: () => Date } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'business-jobs-'))
  directories.push(directory)
  const settings = SettingsSchema.parse({
    sources: { feishu: { enabled: true, config: {} } },
    policy: { sources: { feishu: { allowed: options.allowed === false ? [] : [{ id: 'ou_alice', name: 'Alice' }] } } },
  })
  const triggers = new Map<string, Trigger>()
  const origin: Trigger = { id: TRIGGER, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team' }], actor: { source: 'feishu', id: 'ou_alice' },
    human: options.human !== false, at: new Date(NOW).toISOString(), text: '更新订单数据', meta: {} }
  triggers.set(origin.id, origin)
  const ticket = {
    id: 'ticket-1',
    title: '更新订单数据',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', addressed: 'mention' }, actor: origin.actor, scope: '更新订单数据' },
    origin: { triggerId: origin.id, triggerIds: [origin.id] },
    inputs: [{ id: 'input-origin', kind: 'trigger', triggerId: origin.id, at: origin.at, human: true }],
    undelivered: [], assignments: [], channels: [], createdAt: origin.at, updatedAt: origin.at, decisionId: 'decision-1',
  } as unknown as Ticket
  const runs: { job: string; input: { root: string; runId: string; requestedBy: string } }[] = []
  const runner = vi.fn(async (job: string, input: { root: string; runId: string; requestedBy: string }) => {
    runs.push({ job, input })
    return { status: 'success', summary: '数据更新完成', run_id: input.runId, record_path: join(input.root, 'record.json') } as BusinessJobRun
  })
  const jobs = new BusinessJobs({
    stateDir: directory,
    root: () => directory,
    readTrigger: id => triggers.get(id),
    settings: () => settings,
    now: options.now ?? (() => new Date(NOW)),
    run: runner,
  })
  return { directory, settings, triggers, origin, ticket, runs, runner, jobs }
}

it('runs a registered regular job immediately for an allowlisted explicit requester', async () => {
  const { jobs, ticket, runner, runs } = fixture()
  const result = await jobs.execute(ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)
  expect(result).toMatchObject({ job: 'data-refresh-daily', status: 'success' })
  expect(runner).toHaveBeenCalledOnce()
  expect(runs[0]!.input.requestedBy).toContain(TRIGGER)
  const status = await jobs.status(ticket.id) as { last: { status: string; requestedBy: string }; job: string }
  expect(status.last.status).toBe('success')
  expect(status.last.requestedBy).toContain(TRIGGER)
  expect(status.job).toBe('data-refresh-daily')
})

it('stores no pending state or confirmation code', async () => {
  const { jobs, ticket, directory } = fixture()
  await jobs.execute(ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)
  const name = readdirSync(join(directory, 'business-jobs')).find(item => item.endsWith('.json'))!
  const record = JSON.parse(readFileSync(join(directory, 'business-jobs', name), 'utf8')) as Record<string, unknown>
  expect(record).not.toHaveProperty('pending')
  expect(JSON.stringify(record)).not.toMatch(/confirmation|codeHash|expiresAt/)
})

it('uses the newest human request when no trigger id is supplied', async () => {
  const { jobs, ticket, triggers, runs } = fixture()
  ticket.inputs.push({ id: 'input-followup', kind: 'trigger', triggerId: FOLLOWUP, at: new Date(NOW + 1000).toISOString(), human: true })
  triggers.set(FOLLOWUP, { id: FOLLOWUP, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team' }], actor: { source: 'feishu', id: 'ou_alice' },
    human: true, at: new Date(NOW + 1000).toISOString(), text: '更新订单数据', meta: {} })
  await jobs.execute(ticket, 'data-refresh-daily', undefined, new AbortController().signal)
  expect(runs[0]!.input.requestedBy).toContain(FOLLOWUP)
})

it('rejects an inferred ticket and an unallowlisted requester before running', async () => {
  const inferred = fixture()
  ;(inferred.ticket as unknown as { mandate: { strength: string } }).mandate.strength = 'inferred'
  await expect(inferred.jobs.execute(inferred.ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)).rejects.toThrow('明确授权')
  expect(inferred.runner).not.toHaveBeenCalled()
  const unauthorized = fixture({ allowed: false })
  await expect(unauthorized.jobs.execute(unauthorized.ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal))
    .rejects.toThrow('白名单')
  expect(unauthorized.runner).not.toHaveBeenCalled()
})

it('rejects an unknown job, a job requiring approval, and a trigger that is not on the ticket', async () => {
  const { jobs, ticket, runner } = fixture()
  await expect(jobs.execute(ticket, 'rm-rf' as never, TRIGGER, new AbortController().signal)).rejects.toThrow('未登记')
  const original = BUSINESS_JOBS['data-refresh-daily'].approval
  BUSINESS_JOBS['data-refresh-daily'].approval = 'required'
  try {
    await expect(jobs.execute(ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)).rejects.toThrow('高风险')
  } finally { BUSINESS_JOBS['data-refresh-daily'].approval = original }
  await expect(jobs.execute(ticket, 'data-refresh-daily', 'not-on-ticket', new AbortController().signal)).rejects.toThrow('不属于该工单')
  expect(runner).not.toHaveBeenCalled()
})

it('rejects a non-human origin and does not treat quoted text as a requester', async () => {
  const { jobs, ticket } = fixture({ human: false })
  await expect(jobs.execute(ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)).rejects.toThrow('人类消息')
})

it('recovers a settled service record after a host restart', async () => {
  const { jobs, ticket, directory, triggers, settings } = fixture()
  const serviceRecord = join(directory, 'logs/production-jobs/records/run.json')
  const running = new BusinessJobs({
    stateDir: directory, root: () => directory, readTrigger: id => triggers.get(id), settings: () => settings,
    run: async () => ({ status: 'running', run_id: 'run', record_path: serviceRecord }),
  })
  const result = await running.execute(ticket, 'data-refresh-daily', TRIGGER, new AbortController().signal)
  expect(result.status).toBe('running')
  mkdirSync(join(directory, 'logs/production-jobs/records'), { recursive: true })
  writeFileSync(serviceRecord, JSON.stringify({ status: 'success', summary: '完成', finished_at: new Date(NOW + 2000).toISOString() }))
  const recovered = await jobs.status(ticket.id) as { last: { status: string; summary: string } }
  expect(recovered.last.status).toBe('success')
  expect(recovered.last.summary).toBe('完成')
})

it('launches the service job detached and reads its run_id record', async () => {
  const { launchServiceJob } = await import('../src/app/business-jobs.ts')
  const root = mkdtempSync(join(tmpdir(), 'business-launch-'))
  try {
    mkdirSync(join(root, '.venv/bin'), { recursive: true })
    const python = join(root, '.venv/bin/python')
    writeFileSync(python, `#!/bin/sh
mkdir -p "$PWD/logs/production-jobs/records"
printf '%s\n' '{"status":"success","summary":"fixture","run_id":"'"$MASHANG_JOB_RUN_ID"'"}' > "$PWD/logs/production-jobs/records/$MASHANG_JOB_RUN_ID.json"
exit 0
`, { mode: 0o755 })
    const result = await launchServiceJob('data-refresh-daily', {
      root, runId: 'run-fixture', requestedBy: 'test', signal: new AbortController().signal,
    }, join(root, 'state'))
    expect(result.status).toBe('success')
    expect(result.run_id).toBe('run-fixture')
    expect(result.record_path).toBe(join(root, 'logs/production-jobs/records/run-fixture.json'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('registers business_job for a worker, not for the main Session, and refuses a foreign trigger without running', async () => {
  const { feishu, startRuntime } = await import('./fixtures/host.ts')
  const h = await startRuntime()
  try {
    const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 更新订单数据'))
    expect(h.tools.get(sessionId)!.has('business_job')).toBe(true)
    expect(h.tools.get(h.runtime.masterId)!.has('business_job')).toBe(false)
    await expect(h.runTool(sessionId, 'business_job', { operation: 'run', job_id: 'data-refresh-daily', trigger_id: 'not-on-ticket' }))
      .rejects.toThrow('不属于该工单')
    expect(await h.runTool(sessionId, 'business_job', { operation: 'status' })).toMatchObject({ last: null })
  } finally { await h.stop() }
})
