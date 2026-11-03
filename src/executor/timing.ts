/** Records one worker Session's prepare, model, tool and total time, with the commands it ran, for later comparison. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One shell command a worker ran, with its duration and whether it looks like a script run. */
export interface TimedCommand {
  at: string
  tool: string
  command: string
  durationMs: number
  script: boolean
  error?: boolean
}
/** A `cd` to an absolute path outside the ticket directory, which would leave the prepared execution environment. */
export interface OutsideChange { at: string; command: string; path: string }
/** A command that looks like a filesystem search for a dataset file. */
export interface DatasetSearch { at: string; command: string }
/** One repeated script invocation, which may mean an unnecessary full recomputation. */
export interface RepeatedScript { command: string; count: number }
/** The timing record of one ticket's worker Session, written under `<stateDir>/execution-timings`. */
export interface ExecutionTiming {
  version: 1
  ticketId: string
  directory: string
  prepare?: { startedAt: string; finishedAt: string; durationMs: number }
  agent: { turns: number; steps: number; modelMs: number; toolMs: number; turnMs: number }
  commands: TimedCommand[]
  outsideCds: OutsideChange[]
  parquetSearches: DatasetSearch[]
  repeatedScripts: RepeatedScript[]
  total: { startedAt?: string; finishedAt?: string; durationMs?: number }
  updatedAt: string
}
const SCRIPT = /(?:^|[\s;&|])(?:python[\d.]*|node|deno|bun|ruby|perl|Rscript|make|bash|sh|zsh)\b|\.(?:py|sh|mjs|cjs|js|ts|rb)\b/i
const SEARCH = /\b(?:mdfind|find|locate)\b[^\n]*parquet|\bls\b[^\n]*\.parquet|\bglob\([^\n]*parquet/i
const CHANGE = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
const MAX_COMMANDS = 500, MAX_FINDINGS = 100
const iso = (time: number): string => new Date(time).toISOString()
const text = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Reads a worker tool call's shell command, or its tool name for a call that runs no shell. */
function commandOf(name: string, argumentsText: string): string {
  if (name !== 'bash') return name
  try {
    const parsed = JSON.parse(argumentsText) as { command?: unknown }
    return typeof parsed.command === 'string' ? parsed.command : name
  } catch { return name }
}
/** Returns the absolute paths this command changes into outside `directory`, ignoring temporary areas. */
function outsideChanges(command: string, directory: string): string[] {
  const paths: string[] = []
  for (const match of command.matchAll(CHANGE)) {
    const path = match[1] ?? match[2] ?? match[3]
    if (!path || path.startsWith('$') || path === '..' || path === '.') continue
    if (!path.startsWith('/') && !path.startsWith('~')) continue
    const absolute = path.startsWith('~') ? join(process.env.HOME ?? '', path.slice(1)) : resolve(path)
    const isTemporary = absolute === '/tmp' || absolute.startsWith('/tmp/') || absolute.startsWith('/var/folders/')
    if (isTemporary || absolute === directory || absolute.startsWith(`${directory}${sep}`)) continue
    paths.push(absolute)
  }
  return paths
}

/**
 * Keeps one timing record per ticket in memory and writes it to `<stateDir>/execution-timings/<ticket>.json`.
 * `prepare` records the external prepare command; `observe` folds Session events into model, tool and turn time,
 * command durations, and the signals a review uses to check that the worker stayed in its prepared worktree.
 */
export class ExecutionTimers {
  private readonly records = new Map<string, ExecutionTiming>()
  private readonly openSteps = new Map<string, number>()
  private readonly openTurns = new Map<string, number>()
  private readonly calls = new Map<string, { at: number; tool: string; command: string }>()
  constructor(private readonly stateDir: string) {}
  /** Points a ticket's record at its worktree before its first event. */
  attach(ticketId: string, directory: string): void { this.get(ticketId).directory = directory }
  /** Records how long the external prepare command took, and makes it the start of the total time. */
  prepare(ticketId: string, started: number, finished: number): void {
    const record = this.get(ticketId)
    record.prepare = { startedAt: iso(started), finishedAt: iso(finished), durationMs: Math.max(0, finished - started) }
    if (!record.total.startedAt || started < Date.parse(record.total.startedAt)) record.total.startedAt = iso(started)
    record.total.finishedAt = iso(finished)
    this.setTotal(record)
    this.write(ticketId)
  }
  /** Folds one worker Session event into the ticket's timing record. */
  observe(ticketId: string, event: SessionEvent): void {
    const time = Number.isFinite(event.time) ? event.time : Date.now()
    try {
      const record = this.get(ticketId)
      if (!record.total.startedAt || time < Date.parse(record.total.startedAt)) record.total.startedAt = iso(time)
      record.total.finishedAt = iso(time)
      this.setTotal(record)
      switch (event.type) {
        case 'turn/start':
          record.agent.turns++
          this.openTurns.set(ticketId, time)
          break
        case 'turn/end': {
          const opened = this.openTurns.get(ticketId)
          if (opened !== undefined) record.agent.turnMs += Math.max(0, time - opened)
          this.openTurns.delete(ticketId)
          this.write(ticketId)
          break
        }
        case 'step/start':
          record.agent.steps++
          this.openSteps.set(ticketId, time)
          break
        case 'assistant/message': {
          const opened = this.openSteps.get(ticketId)
          if (opened !== undefined) record.agent.modelMs += Math.max(0, time - opened)
          this.openSteps.delete(ticketId)
          break
        }
        case 'tool/call': {
          const command = commandOf(event.data.name, event.data.arguments)
          this.calls.set(`${ticketId}\0${event.data.callId}`, { at: time, tool: event.data.name, command })
          if (SEARCH.test(command)) {
            record.parquetSearches.push({ at: iso(time), command })
            if (record.parquetSearches.length > MAX_FINDINGS) record.parquetSearches.splice(0, record.parquetSearches.length - MAX_FINDINGS)
          }
          for (const path of outsideChanges(command, record.directory)) {
            record.outsideCds.push({ at: iso(time), command, path })
            if (record.outsideCds.length > MAX_FINDINGS) record.outsideCds.splice(0, record.outsideCds.length - MAX_FINDINGS)
          }
          break
        }
        case 'tool/result': {
          const key = `${ticketId}\0${event.data.message.toolCallId}`
          const call = this.calls.get(key)
          if (!call) break
          this.calls.delete(key)
          record.agent.toolMs += Math.max(0, time - call.at)
          const script = SCRIPT.test(call.command)
          record.commands.push({ at: iso(call.at), tool: call.tool, command: call.command, durationMs: Math.max(0, time - call.at),
            script, ...event.data.message.isError ? { error: true } : {} })
        if (record.commands.length > MAX_COMMANDS) record.commands.splice(0, record.commands.length - MAX_COMMANDS)
        if (call.tool === 'orchestrator_report') this.write(ticketId)
        break
      }
      default:
        break
      }
    } catch { /* Timing is diagnostic; a malformed event never fails the worker. */ }
  }
  /** Writes the record now, so a crash does not lose the prepare or turn timing. */
  flush(ticketId: string): void { this.write(ticketId) }
  /** Writes every record this process touched. */
  flushAll(): void { for (const ticketId of this.records.keys()) this.write(ticketId) }
  /** Returns the current record, primarily for tests and the acceptance summary. */
  read(ticketId: string): ExecutionTiming { return this.get(ticketId) }
  private setTotal(record: ExecutionTiming): void {
    if (record.total.startedAt && record.total.finishedAt) {
      record.total.durationMs = Math.max(0, Date.parse(record.total.finishedAt) - Date.parse(record.total.startedAt))
    }
  }
  private path(ticketId: string): string {
    const safe = ticketId.replace(/[^A-Za-z0-9_.-]/g, '_')
    return join(this.stateDir, 'execution-timings', `${safe}.json`)
  }
  private get(ticketId: string): ExecutionTiming {
    const known = this.records.get(ticketId)
    if (known) return known
    let loaded: ExecutionTiming | undefined
    try { loaded = JSON.parse(readFileSync(this.path(ticketId), 'utf8')) as ExecutionTiming } catch { /* No usable record yet. */ }
    const record: ExecutionTiming = loaded?.version === 1 ? loaded : {
      version: 1, ticketId, directory: '', agent: { turns: 0, steps: 0, modelMs: 0, toolMs: 0, turnMs: 0 },
      commands: [], outsideCds: [], parquetSearches: [], repeatedScripts: [], total: {}, updatedAt: iso(Date.now()),
    }
    record.ticketId = ticketId
    record.directory ||= ''
    record.commands ||= []
    record.outsideCds ||= []
    record.parquetSearches ||= []
    record.repeatedScripts ||= []
    this.records.set(ticketId, record)
    return record
  }
  private write(ticketId: string): void {
    const record = this.get(ticketId)
    const counts = new Map<string, number>()
    for (const command of record.commands.filter(item => item.script)) counts.set(command.command, (counts.get(command.command) ?? 0) + 1)
    record.repeatedScripts = [...counts].filter(([, count]) => count > 1).map(([command, count]) => ({ command, count }))
    record.updatedAt = iso(Date.now())
    const path = this.path(ticketId)
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
      renameSync(temporary, path)
    } catch { /* Timing is diagnostic; it never fails the worker. */ }
  }
}
