import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ExecutionTimers } from '../src/executor/timing.ts'

let state: string
const at = Date.parse('2026-11-03T05:00:00.000Z')
const event = (type: string, time: number, data: object): SessionEvent => ({ type, seq: 1, time, data } as unknown as SessionEvent)
beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'timing-')) })
afterEach(() => { rmSync(state, { recursive: true, force: true }) })

describe('ExecutionTimers', () => {
  it('records prepare, model, tool, turn and total time and writes the record', () => {
    const timers = new ExecutionTimers(state)
    timers.attach('ticket-1', '/work/ticket-1')
    timers.prepare('ticket-1', at, at + 1_000)
    timers.observe('ticket-1', event('turn/start', at + 1_000, { turn: 1 }))
    timers.observe('ticket-1', event('step/start', at + 1_100, { turn: 1, step: 1 }))
    timers.observe('ticket-1', event('assistant/message', at + 1_600, { turn: 1, step: 1, message: {} }))
    timers.observe('ticket-1', event('tool/call', at + 1_700, { turn: 1, step: 1, callId: 'call-1', name: 'bash',
      arguments: JSON.stringify({ command: 'cd /other/checkout && python3 full.py && find /data -name "*.parquet"' }) }))
    timers.observe('ticket-1', event('tool/result', at + 3_700, { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: false } }))
    timers.observe('ticket-1', event('step/end', at + 3_700, { turn: 1, step: 1 }))
    timers.observe('ticket-1', event('step/start', at + 4_000, { turn: 1, step: 2 }))
    timers.observe('ticket-1', event('assistant/message', at + 5_000, { turn: 1, step: 2, message: {} }))
    timers.observe('ticket-1', event('step/end', at + 5_000, { turn: 1, step: 2 }))
    timers.observe('ticket-1', event('turn/end', at + 5_100, { turn: 1, reason: { kind: 'completed' } }))

    const record = timers.read('ticket-1')
    expect(record.prepare).toMatchObject({ durationMs: 1_000 })
    expect(record.agent).toMatchObject({ turns: 1, steps: 2, modelMs: 1_500, toolMs: 2_000, turnMs: 4_100 })
    expect(record.total.durationMs).toBe(5_100)
    expect(record.commands[0]).toMatchObject({ tool: 'bash', durationMs: 2_000, script: true })
    expect(record.outsideCds[0]).toMatchObject({ path: '/other/checkout' })
    expect(record.parquetSearches).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(state, 'execution-timings', 'ticket-1.json'), 'utf8'))).toMatchObject({
      ticketId: 'ticket-1', total: { durationMs: 5_100 }, agent: { modelMs: 1_500 } })
  })

  it('flags a repeated script command', () => {
    const timers = new ExecutionTimers(state)
    const call = (id: string) => [
      event('tool/call', at + 1_000, { turn: 1, step: 1, callId: id, name: 'bash', arguments: JSON.stringify({ command: 'python3 report.py' }) }),
      event('tool/result', at + 2_000, { turn: 1, step: 1, message: { toolCallId: id, isError: false } }),
    ]
    for (const item of [...call('a'), ...call('b')]) timers.observe('ticket-2', item)
    timers.flush('ticket-2')
    expect(timers.read('ticket-2').repeatedScripts).toEqual([{ command: 'python3 report.py', count: 2 }])
  })
})
