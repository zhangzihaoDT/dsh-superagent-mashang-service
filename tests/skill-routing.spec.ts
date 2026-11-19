import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import { installSkillRouting } from '../src/app/skill-routing.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

const diagram: SkillDefinition = {
  name: 'diagram-design', description: 'Create bar, line and scatter charts.', source: 'runtime', provider: 'fixture',
  invocation: { userInvocable: true, modelInvocable: true }, content: 'Use the project chart template.',
}

function fixture(skills = [diagram]) {
  const ctx = new Context(); contexts.push(ctx)
  const session = Session.create(SessionId('skill-routing'))
  const agent = { ctx, session } as Agent
  const ensure = vi.fn(async () => '/effective-workspace')
  const get = vi.fn(async (name: string) => skills.find(skill => skill.name === name))
  ctx.reflect.provide('workingDirectory', { ensure })
  ctx.reflect.provide('skills', { snapshot: async () => ({ skills, complete: true }), get })
  installSkillRouting(ctx)
  const admit = (messages: UserMessage[]): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages })
  const step = (text: string, next = admit, source: UserMessage['source'] = { kind: 'user' }) => {
    const messages = [createUserMessage({ content: [{ type: 'text', text }], source })]
    return agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages, turn: 1, step: 1, signal: new AbortController().signal,
    }, () => next(messages))
  }
  const end = async () => { ctx.emit('session/event', session, session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })) }
  const audit = () => session.snapshotEvents().filter(event => event.type === 'dsh-superagent/skill-routing-audit')
  return { ctx, session, agent, get, audit, step, end }
}

it.each(['使用 diagram-design 绘图', '请先使用 diagram-design Skill。', 'Please use `diagram-design` to plot.'])(
  'loads explicitly named Skill before request admission: %s', async text => {
    const { agent, get, step } = fixture()
    const decision = await step(text)
    expect(get).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledWith(diagram.name, expect.objectContaining({ scope: agent, cwd: '/effective-workspace' }))
    expect(decision).toMatchObject({ kind: 'enter', messages: [expect.anything(), {
      source: { kind: 'skill-invocation', name: diagram.name, form: 'instructions', via: 'natural-language' },
      content: [{ type: 'text', text: renderSkillContent(diagram) }],
    }] })
  },
)

it('reuses the native slash injection without resolving the body twice', async () => {
  const { ctx, get, step } = fixture()
  ctx.on('agent/pre-step', async (_, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const skill = await get(diagram.name)
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill!) }],
      source: { kind: 'skill-invocation', name: diagram.name, form: 'instructions' },
    })] }
  })
  expect(await step('/diagram-design 绘图')).toMatchObject({ messages: [expect.anything(), expect.anything()] })
  expect(get).toHaveBeenCalledOnce()
})

it('supports registered single-word names and applies user invocation policy', async () => {
  const skill = { ...diagram, name: 'report', invocation: { userInvocable: true, modelInvocable: false } }
  const { step } = fixture([skill])
  expect(await step('Use report to summarize.')).toMatchObject({ messages: [expect.anything(), {
    source: { kind: 'skill-invocation', name: 'report' },
  }] })
})

it.each(['/missing-skill 绘图', '使用 missing-skill 绘图', 'Use Skill missing to summarize.'])(
  'gives a clear missing-skill error before continuing: %s', async text => {
    const { get, step } = fixture()
    const next = vi.fn()
    await expect(step(text, next)).rejects.toThrow(/Skill "missing(?:-skill)?" was not found/)
    expect(next).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  },
)

it('rejects forbidden explicit skills before loading their body', async () => {
  const { step, get } = fixture([{ ...diagram, invocation: { userInvocable: false, modelInvocable: true } }])
  await expect(step('使用 diagram-design 绘图')).rejects.toThrow('not available for user invocation')
  expect(get).not.toHaveBeenCalled()
})

it('reports a failed or vanished Skill body as a load error', async () => {
  const { step, get } = fixture()
  get.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValueOnce(undefined)
  await expect(step('使用 diagram-design 绘图')).rejects.toThrow('Could not read Skill "diagram-design"')
  await expect(step('使用 diagram-design 绘图')).rejects.toThrow('its instructions are unavailable')
})

it.each(['completed', 'failed', 'not called'] as const)('audits advisory candidates and actual results when %s', async result => {
  const { session, get, audit, step, end } = fixture()
  expect(await step('请生成一张柱状图并导出 PNG。')).toMatchObject({ kind: 'enter', messages: [expect.anything()] })
  expect(get).not.toHaveBeenCalled()
  expect(audit()).toEqual([])
  const callId = ToolCallId('call-1')
  if (result !== 'not called') {
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'skill', arguments: '{"name":"diagram-design"}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId, isError: result === 'failed', content: [{ type: 'text', text: 'Tool result' }],
    }) }, { surfaceOp: 'append' })
  }
  await end()
  expect(audit()).toHaveLength(1)
  expect(audit()[0]?.data).toMatchObject({
    turn: 1, candidates: [{ name: diagram.name, provider: diagram.provider, basis: expect.arrayContaining(['bar', 'chart']) }],
    actualCalls: result === 'not called' ? [] : [{ name: diagram.name, callId, result }],
  })
})

it.each(['Tell me the capital of France.', '使用 Python 计算', 'Use read-only mode and inspect /tmp first.'])(
  'passes ordinary tasks through: %s', async text => {
    const { get, audit, step, end } = fixture()
    expect(await step(text)).toMatchObject({ kind: 'enter', messages: [expect.anything()] })
    await end()
    expect(get).not.toHaveBeenCalled()
    expect(audit()).toEqual([])
  },
)

it('does not treat a business relay as a direct user invocation', async () => {
  const { get, step } = fixture()
  expect(await step('使用 diagram-design 绘图', undefined, { kind: 'dsh-superagent', form: 'relay' }))
    .toMatchObject({ kind: 'enter', messages: [expect.anything()] })
  expect(get).not.toHaveBeenCalled()
})
