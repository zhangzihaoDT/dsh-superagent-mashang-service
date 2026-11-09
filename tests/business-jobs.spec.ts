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

it('routes LS8 Mix inputs through the generic Worker snapshot operation', async () => {
  const { feishu, startRuntime } = await import('./fixtures/host.ts')
  const h = await startRuntime()
  try {
    const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 刷新 LS8 配置并查询内饰 Mix'))
    const plan = { jobs: ['data-refresh-config-attribute'], datasets: ['config_attribute', 'order_data'] }
    const refresh = vi.spyOn(h.runtime.businessJobs, 'refreshSnapshot').mockResolvedValue({ status: 'success' })
    expect(await h.runTool(sessionId, 'business_job', { operation: 'refresh_snapshot', plan })).toMatchObject({ status: 'success' })
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ mandate: expect.anything() }), plan, undefined, expect.any(AbortSignal))
  } finally { await h.stop() }
})

it('binds a generic snapshot only after all authorized jobs verify and keeps previous versions', async () => {
  const { directory, triggers, settings, ticket } = fixture()
  const run = vi.fn().mockResolvedValue({ status: 'success' })
  const snapshot = vi.fn().mockResolvedValue({ config_attribute: { path: 'config' }, order_data: { path: 'orders' } })
  const jobs = new BusinessJobs({ stateDir: directory, readTrigger: id => triggers.get(id), settings: () => settings, run, snapshot })
  const signal = new AbortController().signal
  const plan = { jobs: ['data-refresh-config-attribute'], datasets: ['config_attribute', 'order_data'] } as const
  const execute = (nextJobs = [...plan.jobs] as ('data-refresh-config-attribute' | 'data-refresh-daily')[], previous?: string) =>
    jobs.refreshSnapshot(ticket, { jobs: nextJobs, datasets: [...plan.datasets], continue_snapshot: previous }, TRIGGER, signal)
  const first = await execute() as { snapshot: { version: string; directory: string; runs: { runId: string }[] } }
  expect(first).toMatchObject({ status: 'success' })
  expect(first).toMatchObject({ snapshot_path: join(first.snapshot.directory, 'snapshot.json'),
    timing_ms: { refresh_and_verify: expect.any(Number), snapshot_and_bind: expect.any(Number) } })
  run.mockResolvedValueOnce({ status: 'success' }).mockResolvedValueOnce({ status: 'verification_failed' })
  expect(await execute(['data-refresh-config-attribute', 'data-refresh-daily'])).toMatchObject({
    status: 'verification_failed', failed_job: 'data-refresh-daily',
  })
  expect(snapshot).toHaveBeenCalledTimes(1)
  snapshot.mockRejectedValueOnce(new Error('source changed'))
  expect(await execute()).toMatchObject({ status: 'snapshot_failed' })
  expect(await jobs.status(ticket.id)).toMatchObject({ analysis_snapshot: { version: first.snapshot.version } })
  await expect(execute(['data-refresh-daily'], 'stale-version')).rejects.toThrow('当前绑定')
  const next = await execute(['data-refresh-daily'], first.snapshot.version) as typeof first
  expect(next.snapshot.version).not.toBe(first.snapshot.version)
  expect(next.snapshot.runs[0]).toEqual(first.snapshot.runs[0])
  expect(snapshot).toHaveBeenLastCalledWith(expect.any(String), next.snapshot.directory,
    [...plan.datasets], next.snapshot.runs.map(item => item.runId), signal)
  expect(JSON.parse(readFileSync(join(first.snapshot.directory, 'snapshot.json'), 'utf8'))).toMatchObject(first.snapshot)
})

it('resolves a primary origin-only trigger but refuses context, secondary origins, and non-human origins', async () => {
  const { directory, triggers, settings, ticket, origin } = fixture()
  const run = vi.fn().mockResolvedValue({ status: 'success' })
  const snapshot = vi.fn().mockResolvedValue({ config_attribute: { path: 'config' }, order_data: { path: 'orders' } })
  const jobs = new BusinessJobs({ stateDir: directory, readTrigger: id => triggers.get(id), settings: () => settings, run, snapshot })
  const originOnly = { ...ticket, inputs: [], origin: { triggerId: TRIGGER, triggerIds: [TRIGGER, FOLLOWUP] } }
  const plan = { jobs: ['data-refresh-config-attribute'], datasets: ['config_attribute', 'order_data'] } as const
  const execute = (current: Ticket, id?: string) => jobs.refreshSnapshot(current,
    { jobs: [...plan.jobs], datasets: [...plan.datasets] }, id, new AbortController().signal)
  await expect(execute(originOnly, TRIGGER)).resolves.toMatchObject({ snapshot: { triggerId: TRIGGER } })
  await expect(execute(originOnly)).resolves.toMatchObject({ snapshot: { triggerId: TRIGGER } })
  const current = await jobs.status(ticket.id)
  triggers.set(FOLLOWUP, { ...origin, id: FOLLOWUP })
  await expect(execute(originOnly, FOLLOWUP)).rejects.toThrow('拒绝生产写入')
  const context = ticket.inputs[0]!
  await expect(execute({ ...originOnly, inputs: [{ ...context, context: true } as typeof context] })).rejects.toThrow('拒绝生产写入')
  triggers.set(TRIGGER, { ...origin, human: false })
  await expect(execute(originOnly, TRIGGER)).rejects.toThrow('拒绝生产写入')
  expect(run).toHaveBeenCalledTimes(2)
  expect(await jobs.status(ticket.id)).toEqual(current)
})

it('rejects an unrelated job and unauthorized generic refresh before starting a write', async () => {
  const { jobs, ticket, runner } = fixture()
  const signal = new AbortController().signal
  await expect(jobs.refreshSnapshot(ticket, { jobs: ['data-refresh-daily'], datasets: ['config_attribute'] }, TRIGGER, signal))
    .rejects.toThrow('覆盖至少一个')
  expect(runner).not.toHaveBeenCalled()
  const unauthorized = fixture({ allowed: false })
  await expect(unauthorized.jobs.refreshSnapshot(unauthorized.ticket, {
    jobs: ['data-refresh-lock-attribution'], datasets: ['lock_attribution'],
  }, TRIGGER, signal)).rejects.toThrow('白名单')
  expect(unauthorized.runner).not.toHaveBeenCalled()
})
