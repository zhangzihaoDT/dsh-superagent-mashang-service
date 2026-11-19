/** Extends DSH's explicit Skill admission and audits advisory matches against actual tool results. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { Session } from '@deepseek-ai/dsh-session'

const slash = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
const named = /(?:^|[\n。！？；：.!?;:]\s*)(?:请\s*)?(?:先\s*)?(?:使用|调用|加载|(?:please\s+)?(?:use|invoke|load)\s+)\s*(?:(skill\b|技能)\s*[:：]?\s*)?[`"“]?([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w./-])[`"”]?(?:\s*(skill\b|技能))?/gi
const aliases = [
  [/柱状图|柱形图/, 'bar chart'], [/折线图/, 'line chart'], [/散点图/, 'scatter chart'],
  [/流程图/, 'flowchart diagram'], [/架构图/, 'architecture diagram'], [/可视化/, 'visualization'],
] as const
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const ignored = new Set(['about', 'and', 'can', 'create', 'data', 'for', 'from', 'generate', 'into', 'make', 'please', 'that', 'the', 'this', 'use', 'using', 'with', 'your'])

function terms(text: string): Set<string> {
  const translated = aliases.filter(([pattern]) => pattern.test(text)).map(([, words]) => words).join(' ')
  const english = (`${text.toLowerCase()} ${translated}`.match(/[a-z][a-z0-9]{2,}/g) ?? [])
    .map(word => word.replace(/(?:charts|diagrams|reports|tables)$/, plural => plural.slice(0, -1)))
    .filter(word => !ignored.has(word))
  const chinese = [...segmenter.segment(text)].map(({ segment }) => segment).filter(word => /^\p{Script=Han}{2,}$/u.test(word))
  return new Set([...english, ...chinese])
}

function candidates(text: string, skills: readonly SkillSummary[]) {
  const query = terms(text)
  return skills.filter(isModelInvocable).flatMap(skill => {
    const basis = [...terms(`${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`)].filter(term => query.has(term))
    return basis.length >= 2 ? [{ name: skill.name, provider: skill.provider, basis }] : []
  })
}

interface SkillRoutingAudit {
  turn: number
  candidates: ReturnType<typeof candidates>
  actualCalls: { name: string | null; callId: string; result: 'unsettled' | 'failed' | 'completed' }[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'dsh-superagent/skill-routing-audit': SkillRoutingAudit
  }
}

function inputText(messages: UserMessage[]): string {
  return messages.filter(message => message.source.kind === 'user').flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}

async function lookup(ctx: Context, agent: Agent, signal: AbortSignal) {
  // Use the same effective workspace as the native slash handler on hosts that expose this service.
  const directory = ctx.get('workingDirectory') as { ensure(agent: Agent, signal: AbortSignal): Promise<string> } | undefined
  return { cwd: directory ? await directory.ensure(agent, signal) : agent.session.header.cwd, signal, scope: agent }
}

export function installSkillRouting(ctx: Context): void {
  const audits = new WeakMap<Session, { turn: number; candidates: ReturnType<typeof candidates> }>()
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const text = inputText(messages)
    if (!text.trim()) return next()

    const gestures = [...text.matchAll(slash)]
    const leading = text.search(/\S/)
    const slashNames = gestures.filter(match => match.index + match[0].indexOf('/') === leading || match[1]!.includes('-'))
      .map(match => match[1]!)
    const wording = [...text.matchAll(named)].map(match => ({
      name: match[2]!.toLowerCase(),
      marked: Boolean(match[1] || match[3]) || (match[2]!.includes('-') &&
        /^\s*(?:$|[。！？；.!?;]|[\p{Script=Han}])/u.test(text.slice(match.index + match[0].length))),
    }))
    const required = new Set([...slashNames, ...wording.filter(item => item.marked).map(item => item.name)])
    let catalog
    let options
    try {
      options = await lookup(ctx, agent, signal)
      catalog = await ctx.skills.snapshot(options)
    } catch (error) {
      signal.throwIfAborted()
      if (required.size) throw new Error(`Cannot discover requested Skill(s): ${[...required].join(', ')}.`, { cause: error })
      ctx.logger.warn('Skill routing audit could not read the catalog for %s', agent.id)
      return next()
    }
    const byName = new Map(catalog.skills.map(skill => [skill.name, skill]))
    for (const { name } of wording) if (byName.has(name)) required.add(name)
    for (const match of gestures) if (byName.has(match[1]!)) required.add(match[1]!)

    for (const name of required) {
      const summary = byName.get(name)
      if (!summary) {
        if (!catalog.complete) throw new Error(`Cannot verify Skill "${name}": discovery is incomplete.`)
        throw new Error(`Skill "${name}" was not found in this Session.`)
      }
      if (!isUserInvocable(summary)) throw new Error(`Skill "${name}" is not available for user invocation.`)
    }

    // Let DSH handle slash invocations first. Use its canonical content and source
    // for natural-language invocations, and avoid a second load for native results.
    const decision = await next().catch((error: unknown) => {
      signal.throwIfAborted()
      if (gestures.length && required.size) throw new Error(`Cannot load requested Skill(s): ${[...required].join(', ')}.`, { cause: error })
      throw error
    })
    if (decision.kind === 'reject') return decision

    const injections: UserMessage[] = []
    for (const name of required) {
      if (decision.messages.some(message => message.source.kind === 'skill-invocation' && message.source.name === name)) continue
      const skill = await ctx.skills.get(name, options).catch((error: unknown) => {
        signal.throwIfAborted()
        throw new Error(`Could not read Skill "${name}".`, { cause: error })
      })
      signal.throwIfAborted()
      if (!skill) throw new Error(`Could not read Skill "${name}": its instructions are unavailable.`)
      if (!isUserInvocable(skill)) throw new Error(`Skill "${name}" is not available for user invocation.`)
      const source = {
        kind: 'skill-invocation', name, form: 'instructions',
        via: gestures.some(match => match[1] === name) ? 'slash' : 'natural-language',
      } as const
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }

    if (!required.size) {
      const matches = candidates(text, catalog.skills)
      if (matches.length) {
        const previous = audits.get(agent.session)
        if (previous?.turn === turn) previous.candidates.push(...matches)
        else audits.set(agent.session, { turn, candidates: matches })
      }
    }
    return injections.length ? { ...decision, messages: [...decision.messages, ...injections] } : decision
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const audit = audits.get(session)
    if (!audit || audit.turn !== event.data.turn) return
    audits.delete(session)
    const calls = new Map<string, SkillRoutingAudit['actualCalls'][number]>()
    for (const item of session.snapshotEvents()) {
      if (item.type === 'tool/call' && item.data.turn === audit.turn && item.data.name === 'skill') {
        let name: string | null = null
        try {
          const args: unknown = JSON.parse(item.data.arguments)
          if (args && typeof args === 'object' && 'name' in args && typeof args.name === 'string') name = args.name
        } catch { /* The tool result records malformed arguments. */ }
        calls.set(item.data.callId, { name, callId: item.data.callId, result: 'unsettled' })
      }
      if (item.type === 'tool/result' && item.data.turn === audit.turn) {
        const call = calls.get(item.data.message.toolCallId)
        if (call) call.result = item.data.message.isError ? 'failed' : 'completed'
      }
    }
    // The Session forbids reentrant appends while publishing turn/end.
    queueMicrotask(() => {
      try {
        session.append('dsh-superagent/skill-routing-audit', {
          turn: audit.turn, candidates: audit.candidates, actualCalls: [...calls.values()],
        })
      } catch (error) {
        ctx.logger.warn('Could not record Skill routing audit for %s: %s', session.id, String(error))
      }
    })
  })
}
