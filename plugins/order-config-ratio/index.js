/**
 * order-config-ratio — model-facing order configuration share query.
 *
 * One tool call does what used to take several: resolve the vehicle /
 * metric / dimension from the service repository's authoritative schema,
 * bind a read-only data snapshot (or run the controlled refresh and bind a
 * fresh one), join order_data with config_attribute, deduplicate at order
 * level, aggregate, and run the quality checks.  The heavy lifting lives in
 * query.py next to this file so the business definitions stay in
 * shared/schema rather than being duplicated in JavaScript.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'query.py')

export const name = 'order-config-ratio'
export const inject = ['tools', 'workingDirectory']

export const Config = z.object({
  repoRoot: z.string().default(''),
  stateDir: z.string().default(''),
  python: z.string().default(''),
  maxAgeHours: z.number().default(24),
  allowRefresh: z.boolean().default(true),
})

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return ''
}

function resolveBusinessRoot(config) {
  return firstExisting([
    config.repoRoot?.trim(),
    process.env.DSH_SUPERAGENT_BUSINESS_ROOT?.trim(),
    join(homedir(), 'Documents', 'github', 'mashang-service'),
  ]) || process.cwd()
}

function resolveDefinitionRoot(cwd, businessRoot) {
  return existsSync(join(cwd, 'shared', 'schema', 'business_definition.json'))
    ? cwd
    : businessRoot
}

function resolveStateDir(config) {
  const configured = config.stateDir?.trim()
  if (configured) return configured
  const home = process.env.DSH_HOME?.trim()
  if (!home) return ''
  const profile = process.env.DSH_PROFILE?.trim() || 'superagent'
  return join(home, 'state', profile)
}

function resolvePython(config, businessRoot) {
  if (config.python?.trim()) return config.python.trim()
  const candidate = join(businessRoot, '.venv', 'bin', 'python')
  return existsSync(candidate) ? candidate : 'python3'
}

function renderReport(value) {
  const markdown = value?.result?.markdown
  if (typeof markdown === 'string' && markdown.trim()) return markdown.trim()
  const summary = value?.summary
  if (typeof summary === 'string' && summary.trim()) return summary.trim()
  return '订单配置占比查询完成，但结果中没有可渲染的摘要。'
}

export function apply(ctx, config) {
  const settings = {
    repoRoot: config?.repoRoot ?? '',
    stateDir: config?.stateDir ?? '',
    python: config?.python ?? '',
    maxAgeHours: Number(config?.maxAgeHours ?? 24),
    allowRefresh: config?.allowRefresh !== false,
  }

  // Declare this query's data needs to the data-preparation plugin when it is
  // present; that plugin then reuses or creates the matching read-only snapshot.
  const requirements = {
    datasets: ['order_data', 'config_attribute'],
    definitions: ['business_definition', 'metrics', 'config_semantics'],
    consumer: 'order_config_ratio',
    description: '订单配置占比查询：订单表、配置表与车型/指标口径',
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['dataPreparation'], child => {
      const service = child.get('dataPreparation')
      if (service?.declare) child.effect(() => service.declare('order_config_ratio', requirements))
    })
  }

  ctx.tools.register(defineTool({
    name: 'order_config_ratio',
    description:
      '查询车型/代际的订单配置占比，一次完成：解析车型、指标与配置维度（复用 shared/schema 权威定义）；' +
      '数据准备插件可用时，由它复用或创建本次分析所需的只读快照（refresh=true 时改为先执行受控生产刷新并绑定新快照，返回各表更新时间）；' +
      '关联 order_data 与 config_attribute、按 order_number 去重、聚合与质量检查；' +
      '返回占比、分母、缺失数、过滤规则、快照与来源。' +
      '适用于“LS8 NEO 锁单五六座占比”“LS8 内饰占比”“CM3 动力类型占比”等问题。' +
      'dimension 支持 seat_count、power_type、product_version、order_type，或配置属性名（内饰/外饰/轮毂/方向盘/已选等）。' +
      'refresh=true 会写生产数据且明显更慢，仅在用户明确要求刷新时使用。',
    parameters: {
      vehicle: {
        type: 'string',
        required: true,
        description: '车型或代际，例如 "LS8 NEO"、"LS8"、"CM3"、"LS6"（LS6 表示全系）。按 business_definition.series_group_logic 解析。',
      },
      metric: {
        type: 'string',
        description: '指标，例如 locked_orders / lock_count / 锁单量、delivered_orders、invoiced_orders。默认 locked_orders。',
      },
      dimension: {
        type: 'string',
        description: '配置维度：seat_count（默认）、power_type、product_version、order_type，或配置属性名（内饰、外饰、轮毂、方向盘、已选、激光雷达等）。',
      },
      refresh: {
        type: 'boolean',
        description: '是否先执行受控生产刷新（data_refresh_daily + data_refresh_config_attribute）并创建一致性快照。默认 false。',
      },
      start_date: {
        type: 'string',
        description: '可选开始日期 YYYY-MM-DD；省略时按上市日（无上市日按预售起点）计算。',
      },
      end_date: {
        type: 'string',
        description: '可选结束日期 YYYY-MM-DD（含当日）；省略时取数据截止日。',
      },
      time_window: {
        type: 'string',
        description: '可选时间窗口：since_launch（默认）、all、last_7_days、last_30_days、mtd、ytd。显式 start_date/end_date 优先。',
      },
      order_type: {
        type: 'string',
        description: '可选订单类型过滤，例如 用户车、试驾车。默认不过滤（与锁单量官方口径一致）。',
      },
      exclude_test_orders: {
        type: 'boolean',
        description: '是否排除试驾车（order_type=试驾车）。默认 false。',
      },
      city: {
        type: 'string',
        description: '可选上牌城市过滤（license_city）。',
      },
      snapshot_dir: {
        type: 'string',
        description: '可选：直接指定快照目录（含 snapshot.json 或 order_data.parquet）。通常由数据准备插件或当前工单 analysisSnapshot 自动选择。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      if (args.refresh && !settings.allowRefresh) {
        throw new Error('order_config_ratio 已禁用 refresh；请使用现有快照，或在插件配置中开启 allowRefresh。')
      }
      let cwd = process.cwd()
      if (exec.agent) {
        try {
          cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        } catch {
          // Keep the process cwd; query.py will fall back to the live dataset.
        }
      }
      const businessRoot = resolveBusinessRoot(settings)
      const definitionRoot = resolveDefinitionRoot(cwd, businessRoot)
      // The data-preparation plugin owns snapshot reuse and creation. When it is
      // absent, query.py keeps its own snapshot discovery and refresh path.
      let prepared
      if (!args.refresh && !args.snapshot_dir) {
        const service = typeof ctx.get === 'function' ? ctx.get('dataPreparation') : undefined
        if (service?.ensure) {
          const result = await service.ensure('order_config_ratio', { cwd, signal: exec.signal })
          if (result.status === 'incomplete' || !result.snapshot?.directory) {
            throw new Error((result.warnings ?? []).join('；') || '数据准备未完成')
          }
          prepared = {
            snapshot_id: result.snapshot_id,
            directory: result.snapshot.directory,
            reused: Boolean(result.reused),
            derived: Boolean(result.derived),
            status: result.status,
            coverage: result.coverage,
            freshness: result.freshness,
          }
        }
      }
      const request = {
        vehicle: args.vehicle,
        metric: args.metric || 'locked_orders',
        dimension: args.dimension || 'seat_count',
        refresh: Boolean(args.refresh),
        start_date: args.start_date || null,
        end_date: args.end_date || null,
        time_window: args.time_window || null,
        order_type: args.order_type || null,
        exclude_test_orders: Boolean(args.exclude_test_orders),
        city: args.city || null,
        snapshot_dir: prepared?.directory ?? args.snapshot_dir ?? null,
        cwd,
        definition_root: definitionRoot,
        business_root: businessRoot,
        state_dir: resolveStateDir(settings),
        python: resolvePython(settings, businessRoot),
        max_age_hours: settings.maxAgeHours,
      }

      let stdout
      try {
        const result = await execFileAsync(
          request.python,
          [SCRIPT, '--request', JSON.stringify(request)],
          {
            cwd,
            timeout: args.refresh ? 840_000 : 180_000,
            maxBuffer: 32 * 1024 * 1024,
            signal: exec.signal,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          },
        )
        stdout = result.stdout
      } catch (error) {
        const stderr = String(error?.stderr || '').trim()
        const detail = stderr ? `：${stderr.slice(-1200)}` : ''
        throw new Error(`order_config_ratio 后端执行失败${detail}`)
      }

      let payload
      try {
        payload = JSON.parse(stdout)
      } catch {
        throw new Error(`order_config_ratio 后端返回了非 JSON 输出：${String(stdout).slice(-800)}`)
      }
      if (payload?.status === 'error') {
        const error = payload.error || {}
        const available = error.available || error.available_dimensions || error.candidates
        const suffix = Array.isArray(available) && available.length
          ? ` 可用值：${available.slice(0, 30).join('、')}`
          : ''
        throw new Error(`${error.code || 'QUERY_ERROR'}: ${error.message || '查询失败'}${suffix}`)
      }
      if (prepared) {
        payload.data_prep = prepared
        if (prepared.status === 'stale') {
          payload.warnings = [...(Array.isArray(payload.warnings) ? payload.warnings : []), '数据准备快照已超过配置的新鲜度阈值；结果已标注数据截止时间，必要时先刷新数据。']
        }
      }
      return payload
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `订单配置占比 · ${args.vehicle || ''} · ${args.dimension || 'seat_count'}`,
        kind: 'other',
        rawInput: args,
      }
    },
  }))
}
