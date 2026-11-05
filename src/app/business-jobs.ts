/** Controlled production business jobs for the Mashang service repository.
 *
 * A person on the Source allowlist is the authorization. Their explicit request starts a
 * registered job immediately; there is no second confirmation code. The worker never runs
 * `make` or a dataset updater itself, and a job marked `approval: 'required'` is refused
 * until a high-risk approval path exists.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../policy.ts'
import { allowedSender } from '../policy.ts'
import { liveTicket, type Ticket, type TicketInput, type Trigger } from '../core/index.ts'

/** How a registered job may start: allowlisted users run `none` directly; `required` waits for a future approval path. */
export type BusinessJobApproval = 'none' | 'required'

interface BusinessJobSpec {
  serviceJob: string
  label: string
  target: string
  description: string
  approval: BusinessJobApproval
}

/** The only production jobs the agent may start. The service repository declares the matching `jobs` entry. */
export const BUSINESS_JOB_IDS = ['data-refresh-daily'] as const
export type BusinessJobId = typeof BUSINESS_JOB_IDS[number]
export const BUSINESS_JOBS: Record<BusinessJobId, BusinessJobSpec> = {
  'data-refresh-daily': {
    serviceJob: 'data_refresh_daily',
    label: '刷新订单与下发线索（daily scope）',
    target: 'data-refresh-daily',
    description: 'Runs make data-refresh-daily, then make data-status in the production checkout.',
    approval: 'none',
  },
}

/** Terminal service states; anything else means the service job has not settled. */
const TERMINAL = new Set(['success', 'no_new_data', 'failed', 'timeout', 'verification_failed', 'busy'])
const RUN_LIMIT_MS = 35 * 60_000
const POLL_MS = 1_000

export interface BusinessJobLast {
  id: string
  job: BusinessJobId
  status: string
  runId: string
  startedAt: string
  finishedAt?: string
  requestedBy: string
  serviceRecordPath?: string
  summary?: string
  error?: string
}
interface BusinessJobRecord { version: 1; ticketId: string; last?: BusinessJobLast }
export type BusinessJobRun = Record<string, unknown> & { status?: string; summary?: string; error?: string; run_id?: string; record_path?: string }

/** The production checkout. It is deliberately separate from the ticket worktree. */
export const businessRoot = (env = process.env): string =>
  env.DSH_SUPERAGENT_BUSINESS_ROOT?.trim() || join(homedir(), 'Documents/github/mashang-service')

export interface BusinessJobsOptions {
  stateDir: string
  root?: () => string
  readTrigger?: (id: string) => Trigger | undefined
  settings?: () => Settings
  now?: () => Date
  /** Test seam: replaces the detached service-job launcher. */
  run?: (job: BusinessJobId, input: { root: string; runId: string; requestedBy: string; signal: AbortSignal }) => Promise<BusinessJobRun>
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const terminal = (status: string | undefined): boolean => !!status && TERMINAL.has(status)
const pathSafe = (id: string): string => hash(id).slice(0, 24)

/** Reads a JSON file, treating a missing file as `undefined`. */
async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Writes a JSON file atomically so a worker or a restarted host never reads half a record. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  await rename(temporary, path)
}

async function tail(path: string, limit = 6000): Promise<string> {
  try {
    const info = await stat(path)
    const handle = await open(path, 'r')
    try {
      const length = Math.min(limit, info.size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, Math.max(0, info.size - length))
      return buffer.toString('utf8')
    } finally { await handle.close() }
  } catch { return '' }
}

/** The last JSON object a service job printed, such as its structured failure before it wrote a run record. */
async function lastJson(path: string): Promise<BusinessJobRun | undefined> {
  const text = await tail(path, 20_000)
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as BusinessJobRun
    } catch { /* Not a JSON line. */ }
  }
  return undefined
}

/**
 * Starts the service job detached, then polls the service-side record it names by `run_id`.
 * A host restart or an aborted tool call does not kill the business job; `status` can recover it.
 */
export async function launchServiceJob(job: BusinessJobId, input: { root: string; runId: string; requestedBy: string; signal: AbortSignal }, stateDir: string): Promise<BusinessJobRun> {
  const spec = BUSINESS_JOBS[job]
  const python = join(input.root, '.venv/bin/python')
  const logDirectory = join(stateDir, 'business-jobs')
  await mkdir(logDirectory, { recursive: true, mode: 0o700 })
  const logPath = join(logDirectory, `${input.runId}.log`)
  const handle = await open(logPath, 'a', 0o600)
  try {
    const child = spawn(python, ['-m', 'jobs.cli', '--job', spec.serviceJob, '--format', 'json'], {
      cwd: input.root,
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
      env: { ...process.env, MASHANG_JOB_RUN_ID: input.runId, MASHANG_JOB_REQUESTED_BY: input.requestedBy },
    })
    let spawnError: Error | undefined
    child.on('error', error => { spawnError = error })
    child.unref()
    const recordPath = join(input.root, 'logs/production-jobs/records', `${input.runId}.json`)
    const deadline = Date.now() + RUN_LIMIT_MS
    for (;;) {
      const record = await readJson<BusinessJobRun>(recordPath)
      if (record && terminal(record.status)) return { ...record, record_path: recordPath }
      if (spawnError) return { status: 'failed', run_id: input.runId, error: `无法启动服务 Job：${spawnError.message}`, log: await tail(logPath) }
      if (input.signal.aborted) return { status: 'running', run_id: input.runId, record_path: recordPath, error: '工具调用已取消；生产任务继续运行，可用 status 恢复' }
      if (Date.now() >= deadline) return { status: 'timeout', run_id: input.runId, record_path: recordPath, error: `等待生产任务超过 ${RUN_LIMIT_MS / 60_000} 分钟` }
      if (child.exitCode !== null && !record) {
        const logged = await lastJson(logPath)
        return { status: 'failed', run_id: input.runId,
          error: logged?.error ?? `服务 Job 退出码 ${child.exitCode} 且没有运行记录`, log: await tail(logPath) }
      }
      await sleep(POLL_MS)
    }
  } finally { await handle.close() }
}

/**
 * Authorization and execution state for registered production jobs.
 * An explicit Ticket from a human on the Source allowlist runs a registered `approval: 'none'`
 * job immediately; no pending state or confirmation code is stored.
 */
export class BusinessJobs {
  private readonly now: () => Date
  private readonly root: () => string
  private readonly readTrigger: (id: string) => Trigger | undefined
  private readonly settings: () => Settings
  private readonly run: NonNullable<BusinessJobsOptions['run']>
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: BusinessJobsOptions) {
    this.now = options.now ?? (() => new Date())
    this.root = options.root ?? (() => businessRoot())
    this.readTrigger = options.readTrigger ?? (() => undefined)
    this.settings = options.settings ?? (() => { throw new Error('Business job settings are unavailable') })
    this.run = options.run ?? ((job, input) => launchServiceJob(job, input, options.stateDir))
  }

  private path(ticketId: string): string { return join(this.options.stateDir, 'business-jobs', `${pathSafe(ticketId)}.json`) }

  /** Serializes mutations for one ticket so two tool calls cannot start the same ticket's job twice. */
  private async exclusive<T>(ticketId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(ticketId) ?? Promise.resolve()
    const current = previous.then(run, run)
    const tail = current.then(() => undefined, () => undefined)
    this.queues.set(ticketId, tail)
    try { return await current } finally { if (this.queues.get(ticketId) === tail) this.queues.delete(ticketId) }
  }

  private async record(ticketId: string): Promise<BusinessJobRecord> {
    return await readJson<BusinessJobRecord>(this.path(ticketId)) ?? { version: 1, ticketId }
  }

  /** Resolves the human request this run answers: the named trigger, else the newest human trigger on the ticket. */
  private requester(ticket: Ticket, triggerId?: string): Trigger {
    const human = ticket.inputs.filter((item): item is Extract<TicketInput, { kind: 'trigger' }> =>
      item.kind === 'trigger' && !!item.human && !item.context)
    if (triggerId) {
      const input = human.find(item => item.triggerId === triggerId)
      const trigger = input ? this.readTrigger(triggerId) : undefined
      if (!input || !trigger || !trigger.human) throw new Error('这条请求不属于该工单，或不是人类消息，拒绝生产写入。')
      return trigger
    }
    const input = [...human].sort((left, right) => right.at.localeCompare(left.at))[0]
    const resolved = input ? this.readTrigger(input.triggerId) : this.readTrigger(ticket.origin.triggerId)
    if (!resolved || !resolved.human) throw new Error('找不到这条请求对应的人类消息，拒绝生产写入。')
    return resolved
  }

  /** Verifies identity, Source allowlist and the job allowlist, then runs the registered service job immediately. */
  async execute(ticket: Ticket, job: BusinessJobId, triggerId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    return await this.exclusive(ticket.id, async () => {
      if (!liveTicket(ticket)) throw new Error('工单已结束，不能执行生产任务。')
      if (ticket.mandate.strength !== 'explicit') throw new Error('只有被明确授权的工单可以执行生产任务；推断任务不允许。')
      if (!Object.hasOwn(BUSINESS_JOBS, job)) throw new Error(`未登记的生产 Job：${job}`)
      const spec = BUSINESS_JOBS[job]
      if (spec.approval !== 'none') throw new Error(`Job ${job} 属于高风险操作，需要审批；当前未启用审批执行，已拒绝。`)

      const requester = this.requester(ticket, triggerId)
      if (!allowedSender(this.settings(), requester.actor)) {
        throw new Error('请求人不在当前 Source 的用户白名单中，拒绝生产写入。')
      }

      const runId = `dsh-${randomUUID().replaceAll('-', '')}`
      const startedAt = this.now().toISOString()
      const record = await this.record(ticket.id)
      const requestedBy = triggerLabel(requester).slice(0, 200)
      record.last = {
        id: runId, job, status: 'running', runId, startedAt, requestedBy,
        serviceRecordPath: join(this.root(), 'logs/production-jobs/records', `${runId}.json`),
      }
      await writeJson(this.path(ticket.id), record)
      try {
        const result = await this.run(job, { root: this.root(), runId, requestedBy, signal })
        const status = typeof result.status === 'string' ? result.status : 'failed'
        record.last = {
          ...record.last,
          status,
          finishedAt: this.now().toISOString(),
          summary: typeof result.summary === 'string' ? result.summary : undefined,
          error: typeof result.error === 'string' ? result.error : undefined,
          serviceRecordPath: typeof result.record_path === 'string' ? result.record_path : record.last.serviceRecordPath,
        }
        await writeJson(this.path(ticket.id), record)
        return { job, run_id: runId, status, result: compactRun(result) }
      } catch (error) {
        record.last = {
          ...record.last, status: 'failed', finishedAt: this.now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        await writeJson(this.path(ticket.id), record)
        throw error
      }
    })
  }

  /** Returns the latest run, recovering a settled service record after a host restart. */
  async status(ticketId: string): Promise<Record<string, unknown>> {
    return await this.exclusive(ticketId, async () => {
      const record = await this.record(ticketId)
      if (record.last?.status === 'running' && record.last.serviceRecordPath) {
        const service = await readJson<BusinessJobRun>(record.last.serviceRecordPath)
        if (service && terminal(service.status)) {
          record.last = {
            ...record.last,
            status: String(service.status),
            finishedAt: typeof service.finished_at === 'string' ? service.finished_at : this.now().toISOString(),
            summary: typeof service.summary === 'string' ? service.summary : undefined,
            error: typeof service.error === 'string' ? service.error : undefined,
          }
          await writeJson(this.path(ticketId), record)
        }
      }
      return { last: record.last ?? null, job: record.last?.job ?? null }
    })
  }
}

const triggerLabel = (trigger: Pick<Trigger, 'id' | 'actor'>): string => `trigger/${trigger.id}@${trigger.actor.source}:${trigger.actor.id}`

/** The part of a service record a worker and its report need; the full record stays in the service log directory. */
function compactRun(result: BusinessJobRun): Record<string, unknown> {
  const keys = ['status', 'summary', 'error', 'run_id', 'latest_data_time', 'latest_data_time_by_dataset', 'changed_datasets',
    'new_data', 'warnings', 'commands', 'log_path', 'record_path']
  return Object.fromEntries(keys.filter(key => key in result).map(key => [key, result[key]]))
}
