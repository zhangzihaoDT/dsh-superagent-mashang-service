/**
 * dsh-data-prep — one catalog, one freshness policy, and read-only analysis
 * snapshots for every analysis plugin in this profile.
 *
 * The business repository stays the single source of truth: the dataset
 * registry declares the datasets, their paths and business date columns, and
 * `shared/schema/*.json` declares the vehicle and metric definitions. This
 * plugin only reads those declarations and the dataset files. It never runs a
 * production refresh: a refresh stays with the authorized `business_job` tool,
 * and this plugin reuses the verified snapshot such a refresh binds.
 *
 * Two cooperation surfaces:
 *  - the `data_prepare` tool for the model, and
 *  - the `dataPreparation` Host service for analysis plugins:
 *      ctx.dataPreparation.declare('order_config_ratio', {
 *        datasets: ['order_data', 'config_attribute'],
 *        definitions: ['business_definition', 'metrics', 'config_semantics'],
 *        consumer: 'order_config_ratio',
 *      })
 *      const { snapshot } = await ctx.dataPreparation.ensure('order_config_ratio')
 *
 * A snapshot is a directory with a `snapshot.json` manifest and either copied
 * read-only dataset files (`mode: 'copy'`) or read-only links to a verified
 * refresh snapshot (`mode: 'link'`). The manifest is compatible with the
 * order-config-ratio query's snapshot reader: `version`, `datasets[id].path`,
 * `rows`, `size_bytes`, `file_mtime`, `data_asof` and `data_asof_column`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const name = 'data-prep'
export const inject = ['tools']

const VERSION = '0.1.0'
const MANIFEST_VERSION = 1
const HOUR = 3_600_000
const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE_SCRIPT = join(HERE, 'dataset_probe.py')
const CATALOG_TTL_MS = 30_000
const exec = promisify(execFile)

const messageOf = (error) => error instanceof Error ? error.message : String(error)

/** The tool registry validates a canonical value as lossless JSON; drop undefined members, not data. */
function lossless(value) {
  if (Array.isArray(value)) return value.map(lossless)
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = lossless(item)
    }
    return result
  }
  return value
}
const nowIso = (now = new Date()) => now.toISOString()
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const unique = (values) => [...new Set(values)]
const optionalPositive = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** Resolves the profile's state directory; snapshots live under it, never in the business checkout. */
function defaultStateDir() {
  const home = process.env.DSH_HOME?.trim()
  if (!home) return ''
  return join(home, 'state', process.env.DSH_PROFILE?.trim() || 'default')
}

function settingsOf(config = {}) {
  const businessRoot = resolve(config.businessRoot?.trim() || process.cwd())
  const stateDir = String(config.stateDir ?? '').trim() ? resolve(String(config.stateDir).trim()) : defaultStateDir()
  const venvPython = join(businessRoot, '.venv/bin/python')
  const python = String(config.python ?? '').trim() || (existsSync(venvPython) ? venvPython : 'python3')
  const definitions = (config.definitions ?? [])
    .map(normalizeDefinition)
  const requirements = {}
  for (const [profile, value] of Object.entries(config.requirements ?? {})) {
    requirements[profile] = normalizeProfile(profile, value)
  }
  return {
    businessRoot,
    registry: config.registry,
    stateDir,
    python,
    definitions,
    requirements,
    datasets: Array.isArray(config.datasets) ? config.datasets.map(normalizeDataset) : [],
    snapshotsDir: stateDir ? join(stateDir, 'data-prep', 'snapshots') : '',
    maxAgeHours: optionalPositive(config.maxAgeHours) ?? 24,
    freshness: Object.fromEntries(Object.entries(config.freshness ?? {})
      .map(([id, value]) => [id, optionalPositive(value)])
      .filter(([, value]) => value !== undefined)),
    registeredJobs: (config.registeredJobs ?? []).map(String),
    reuseAnalysisSnapshots: config.reuseAnalysisSnapshots !== false,
    catalogTimeoutMs: optionalPositive(config.catalogTimeoutMs) ?? 60_000,
    probeTimeoutMs: optionalPositive(config.probeTimeoutMs) ?? 180_000,
    copyTimeoutMs: optionalPositive(config.copyTimeoutMs) ?? 180_000,
  }
}

function normalizeDataset(raw) {
  const id = String(raw?.id ?? raw?.key ?? '').trim()
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`数据集 id 非法：${JSON.stringify(raw?.id ?? raw?.key)}`)
  const path = String(raw?.path ?? '').trim()
  if (!path) throw new Error(`数据集 ${id} 缺少 path`)
  const dateColumns = (raw?.date_columns ?? raw?.dateColumns ?? []).map(String).filter(Boolean)
  return {
    id,
    label: String(raw?.label ?? id),
    path,
    required: raw?.required === true,
    stepId: String(raw?.step_id ?? raw?.stepId ?? ''),
    dateColumns,
    maxAgeHours: optionalPositive(raw?.max_age_hours ?? raw?.maxAgeHours),
    note: String(raw?.note ?? ''),
    origin: String(raw?.origin ?? 'registry'),
  }
}

function normalizeDefinition(raw) {
  const id = String(raw?.id ?? '').trim()
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`口径定义 id 非法：${JSON.stringify(raw?.id)}`)
  const path = String(raw?.path ?? '').trim()
  if (!path) throw new Error(`口径定义 ${id} 缺少 path`)
  return { id, path, label: String(raw?.label ?? id) }
}

function normalizeConsumer(raw) {
  if (!raw) return undefined
  if (typeof raw === 'string') return { tool: raw, argument: 'snapshot_dir' }
  if (typeof raw === 'object' && typeof raw.tool === 'string' && raw.tool.trim()) {
    return { tool: raw.tool.trim(), argument: String(raw.argument ?? 'snapshot_dir').trim() || 'snapshot_dir' }
  }
  return undefined
}

function normalizeProfile(profile, raw) {
  const value = typeof raw === 'string' ? { description: raw } : raw ?? {}
  const datasets = value.datasets === undefined ? [] : value.datasets.map(String).filter(Boolean)
  const definitions = value.definitions === undefined ? [] : value.definitions.map(String).filter(Boolean)
  return {
    name: profile,
    datasets,
    definitions,
    maxAgeHours: optionalPositive(value.max_age_hours ?? value.maxAgeHours),
    consumer: normalizeConsumer(value.consumer),
    description: String(value.description ?? ''),
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const okPath = async (path) => stat(path).then((info) => info.isFile(), () => false)

function sourcePath(settings, relative) {
  return isAbsolute(relative) ? relative : resolve(settings.businessRoot, relative)
}

const hashCache = new Map()
async function streamHash(path, signal) {
  const digest = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path, signal ? { signal } : {})
    stream.on('data', (chunk) => digest.update(chunk)).on('error', reject).on('end', resolvePromise)
  })
  return digest.digest('hex')
}

async function sha256(path, signal) {
  const info = await stat(path)
  const key = `${path}:${info.size}:${Math.round(info.mtimeMs)}`
  const cached = hashCache.get(key)
  if (cached) return cached
  const digest = await streamHash(path, signal)
  hashCache.set(key, digest)
  if (hashCache.size > 512) hashCache.delete(hashCache.keys().next().value)
  return digest
}

async function run(settings, args, signal, timeout) {
  try {
    const { stdout } = await exec(settings.python, ['-B', ...args], {
      cwd: settings.businessRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    })
    return stdout
  } catch (error) {
    const detail = String(error?.stderr ?? '').trim() || String(error?.stdout ?? '').trim() || messageOf(error)
    throw new Error(`数据准备后端执行失败：${detail.slice(-800)}`)
  }
}

const catalogCaches = new WeakMap()
async function readCatalog(settings, signal) {
  if (!settings.businessRoot || !existsSync(settings.businessRoot)) {
    throw new Error(`业务仓库不存在：${settings.businessRoot}；请设置插件 config.businessRoot。`)
  }
  const cached = catalogCaches.get(settings)
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
  let payload = {}
  if (settings.registry === 'mashang') {
    const stdout = await run(settings, [PROBE_SCRIPT, 'catalog', '--root', settings.businessRoot], signal, settings.catalogTimeoutMs)
    try {
      payload = JSON.parse(stdout)
    } catch {
      throw new Error(`数据集清单不是 JSON：${stdout.slice(0, 400)}`)
    }
    if (payload.error) throw new Error(`数据集清单读取失败：${payload.error}`)
  }
  const byId = new Map()
  for (const raw of payload.datasets ?? []) {
    const spec = normalizeDataset(raw)
    byId.set(spec.id, spec)
  }
  for (const override of settings.datasets) {
    const existing = byId.get(override.id)
    byId.set(override.id, existing
      ? { ...existing, ...override, maxAgeHours: override.maxAgeHours ?? existing.maxAgeHours }
      : { ...override, origin: 'config' })
  }
  for (const [id, maxAgeHours] of Object.entries(settings.freshness)) {
    const existing = byId.get(id)
    if (existing) byId.set(id, { ...existing, maxAgeHours })
  }
  const value = {
    businessRoot: settings.businessRoot,
    datasets: [...byId.values()],
    jobs: (payload.jobs ?? []).map((job) => ({ id: String(job.id), datasets: (job.datasets ?? []).map(String) })),
  }
  catalogCaches.set(settings, { at: Date.now(), value })
  return value
}

async function probeFile(settings, path, columns, signal) {
  const request = JSON.stringify({ path, columns, now: new Date().toISOString() })
  let stdout
  try {
    stdout = await run(settings, [PROBE_SCRIPT, 'probe', '--request', request], signal, settings.probeTimeoutMs)
  } catch (error) {
    throw new Error(`数据探测失败（${path}）：${messageOf(error)}`)
  }
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error(`数据探测结果不是 JSON（${path}）：${stdout.slice(0, 400)}`)
  }
  if (payload.error) throw new Error(`数据探测失败（${path}）：${payload.error}`)
  return payload
}

function latestCutoff(probe, columns, now) {
  const limit = now.getTime()
  const hits = (probe.cutoffs ?? [])
    .filter((hit) => columns.includes(hit.column) && Number.isFinite(Date.parse(hit.at)) && Date.parse(hit.at) <= limit)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  return hits.at(-1)
}

function ageOf(basis, now) {
  const at = Date.parse(basis)
  return Number.isFinite(at) ? round((now.getTime() - at) / HOUR) : undefined
}

async function inspectLiveDataset(settings, spec, now, probeLive, signal) {
  const path = sourcePath(settings, spec.path)
  const maxAgeHours = spec.maxAgeHours ?? settings.maxAgeHours
  const base = {
    id: spec.id,
    label: spec.label,
    path,
    required: spec.required,
    date_columns: spec.dateColumns,
    exists: false,
    size_bytes: null,
    file_mtime: null,
    rows: null,
    data_asof: null,
    data_asof_column: null,
    max_age_hours: maxAgeHours,
    age_hours: null,
    fresh: false,
    basis: 'file_mtime',
    warnings: [],
  }
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return { ...base, warnings: [`数据集文件缺失：${path}`] }
  base.exists = true
  base.size_bytes = info.size
  base.file_mtime = info.mtime.toISOString()
  if (probeLive && spec.dateColumns.length) {
    try {
      const probe = await probeFile(settings, path, spec.dateColumns, signal)
      base.rows = probe.rows ?? null
      const cutoff = latestCutoff(probe, spec.dateColumns, now)
      if (cutoff) {
        base.data_asof = cutoff.at
        base.data_asof_column = cutoff.column
        base.basis = 'data_asof'
      }
    } catch (error) {
      base.warnings.push(messageOf(error))
    }
  }
  const basis = base.data_asof ?? base.file_mtime
  base.age_hours = ageOf(basis, now)
  base.fresh = base.age_hours !== undefined && base.age_hours <= maxAgeHours
  return base
}

async function inspectLiveDefinition(settings, definition, definitionRoot, signal) {
  const path = sourcePath({ businessRoot: definitionRoot }, definition.path)
  const info = await stat(path).catch(() => undefined)
  const record = {
    id: definition.id,
    label: definition.label,
    path,
    exists: Boolean(info?.isFile()),
    size_bytes: info?.isFile() ? info.size : null,
    mtime: info?.isFile() ? info.mtime.toISOString() : null,
    sha256: null,
    warnings: [],
  }
  if (record.exists) {
    try {
      record.sha256 = await sha256(path, signal)
    } catch (error) {
      record.warnings.push(messageOf(error))
    }
  } else {
    record.warnings.push(`口径文件缺失：${path}`)
  }
  return record
}

/** A worktree's schema is preferred when it carries every configured definition. */
function chooseDefinitionRoot(cwd, settings) {
  if (cwd) {
    const complete = settings.definitions.every((definition) => existsSync(sourcePath({ businessRoot: cwd }, definition.path)))
    if (complete) return resolve(cwd)
  }
  return settings.businessRoot
}

function profilesOf(settings, declared) {
  const merged = new Map()
  for (const [profile, value] of Object.entries(settings.requirements)) {
    merged.set(profile, { ...normalizeProfile(profile, value), source: 'config' })
  }
  for (const [profile, value] of declared) {
    merged.set(profile, { ...normalizeProfile(profile, value), source: 'declared' })
  }
  return [...merged.values()]
}

function resolveRequirements(input, settings, catalog, profiles) {
  const requested = typeof input === 'string' ? { profile: input } : { ...(input ?? {}) }
  const byName = new Map(profiles.map((profile) => [profile.name, profile]))
  let base = {}
  if (requested.profile) {
    base = byName.get(String(requested.profile))
    if (!base && String(requested.profile) === 'all') {
      base = {
        name: 'all',
        datasets: catalog.datasets.map((dataset) => dataset.id),
        definitions: settings.definitions.map((definition) => definition.id),
        description: '项目内全部数据集与口径定义',
        source: 'built-in',
      }
    }
    if (!base) throw new Error(`未知需求 profile：${requested.profile}；可用：${['all', ...byName.keys()].join('、')}`)
  }
  const rawDatasets = requested.datasets ?? base.datasets ?? []
  const datasets = unique(rawDatasets.map(String).flatMap((id) => (id === 'all' ? catalog.datasets.map((dataset) => dataset.id) : [id])))
  if (!datasets.length) throw new Error('需要至少一个数据集：传 profile 或 datasets。')
  const definitions = unique((requested.definitions ?? base.definitions ?? []).map(String))
  const explicitMaxAgeHours = optionalPositive(requested.max_age_hours ?? requested.maxAgeHours)
    ?? optionalPositive(base.maxAgeHours)
  return {
    profile: requested.profile ? String(requested.profile) : null,
    datasets,
    definitions,
    maxAgeHours: explicitMaxAgeHours ?? settings.maxAgeHours,
    explicitMaxAgeHours,
    consumer: normalizeConsumer(requested.consumer) ?? base.consumer,
    description: String(requested.description ?? base.description ?? ''),
  }
}

function datasetLimit(spec, requirements, settings) {
  return requirements.explicitMaxAgeHours ?? spec.maxAgeHours ?? settings.maxAgeHours
}

function coverageOf(requirements, providedDatasets, providedDefinitions) {
  const missingDatasets = requirements.datasets.filter((id) => !providedDatasets.includes(id))
  const missingDefinitions = requirements.definitions.filter((id) => !providedDefinitions.includes(id))
  const required = requirements.datasets.length + requirements.definitions.length
  const provided = required - missingDatasets.length - missingDefinitions.length
  return {
    required_datasets: requirements.datasets,
    provided_datasets: requirements.datasets.filter((id) => providedDatasets.includes(id)),
    missing_datasets: missingDatasets,
    required_definitions: requirements.definitions,
    provided_definitions: requirements.definitions.filter((id) => providedDefinitions.includes(id)),
    missing_definitions: missingDefinitions,
    complete: missingDatasets.length === 0 && missingDefinitions.length === 0,
    percent: required ? round((provided / required) * 100, 1) : 100,
  }
}

function freshnessOf(manifest, requirements, settings, datasetById, now) {
  const stale = []
  const unknown = []
  let oldest
  for (const id of requirements.datasets) {
    const entry = manifest.datasets?.[id]
    const basis = entry?.data_asof ?? entry?.file_mtime
    const age = basis ? ageOf(basis, now) : undefined
    const spec = datasetById.get(id) ?? { id }
    const limit = datasetLimit(spec, requirements, settings)
    if (age === undefined) unknown.push(id)
    else {
      oldest = oldest === undefined ? age : Math.max(oldest, age)
      if (age > limit) stale.push({ id, age_hours: age, max_age_hours: limit, data_asof: entry?.data_asof ?? null })
    }
  }
  return {
    evaluated_at: nowIso(now),
    max_age_hours: requirements.maxAgeHours,
    oldest_age_hours: oldest ?? null,
    fresh: stale.length === 0 && unknown.length === 0,
    stale_datasets: stale,
    unknown_datasets: unknown,
  }
}

function refreshPlanFor(catalog, requirements, freshness, settings) {
  const staleIds = freshness.stale_datasets.map((entry) => entry.id)
  if (!staleIds.length) return undefined
  const jobs = catalog.jobs.filter((job) => job.datasets.some((id) => staleIds.includes(id)))
  const registered = jobs.filter((job) => settings.registeredJobs.includes(job.id))
  const covered = unique(registered.flatMap((job) => job.datasets)).filter((id) => staleIds.includes(id))
  const uncovered = staleIds.filter((id) => !covered.includes(id))
  return {
    stale_datasets: staleIds,
    jobs: jobs.map((job) => job.id),
    registered_jobs: registered.map((job) => job.id),
    recommended_business_job: registered.length
      ? { operation: 'refresh_snapshot', plan: { jobs: registered.map((job) => job.id), datasets: covered } }
      : undefined,
    uncovered_datasets: uncovered,
    note: registered.length
      ? '生产刷新由已授权的人类请求通过 business_job 执行；刷新完成后再调用 data_prepare 复用刷新绑定的快照。'
      : '这些数据集没有登记到 business_job，请按业务仓库的 allupdate 或各自独立入口更新。',
  }
}

function summarize(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    created_at: manifest.created_at,
    origin: manifest.origin,
    mode: manifest.mode,
    directory: manifest.directory,
    datasets: Object.keys(manifest.datasets ?? {}),
    definitions: Object.keys(manifest.definitions ?? {}),
    coverage: manifest.coverage,
    freshness: manifest.freshness,
    subject: manifest.subject,
  }
}

async function listSnapshotManifests(settings) {
  if (!settings.snapshotsDir) return []
  const names = await readdir(settings.snapshotsDir).catch(() => [])
  const manifests = []
  for (const id of names) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) continue
    const directory = join(settings.snapshotsDir, id)
    const manifestPath = join(directory, 'snapshot.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest?.id !== id || !manifest.datasets) continue
      manifests.push({ ...manifest, directory, manifest_path: manifestPath })
    } catch {
      // A half-written or removed snapshot is not a candidate; it stays ignored.
    }
  }
  manifests.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
  return manifests
}

async function listAnalysisSnapshots(settings) {
  const directory = join(settings.stateDir, 'business-jobs')
  const names = await readdir(directory).catch(() => [])
  const snapshots = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
      const snapshot = record?.analysisSnapshot
      if (!snapshot?.directory || !snapshot?.datasets) continue
      const info = await stat(join(snapshot.directory, 'snapshot.json')).catch(() => undefined)
      if (!info?.isFile()) continue
      snapshots.push({ ...snapshot, created_at: info.mtime.toISOString() })
    } catch {
      // Ignore a record that is not a bound snapshot with a readable manifest.
    }
  }
  return snapshots.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
}

async function copyReadOnly(source, destination, signal, timeoutMs) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const before = await stat(source)
  try {
    await exec('cp', ['-c', '-p', '--', source, destination], { signal, timeout: timeoutMs })
  } catch (error) {
    if (signal?.aborted) throw error
    try {
      await exec('cp', ['-p', '--', source, destination], { signal, timeout: timeoutMs })
    } catch (fallbackError) {
      if (signal?.aborted) throw fallbackError
      await copyFile(source, destination)
      const info = await stat(source)
      await utimes(destination, info.atime, info.mtime)
    }
  }
  await chmod(destination, 0o444)
  const after = await stat(source)
  if (after.ino !== before.ino || after.size !== before.size || Math.round(after.mtimeMs) !== Math.round(before.mtimeMs)) {
    throw new Error(`源文件在复制期间被更新：${source}`)
  }
  const copied = await stat(destination)
  if (copied.size !== after.size) throw new Error(`复制后的文件大小不一致：${destination}`)
  return copied
}

async function datasetRecord(settings, spec, destination, source, requirements, now, signal) {
  const fileInfo = await stat(destination)
  const record = {
    id: spec.id,
    label: spec.label,
    path: destination,
    required: spec.required,
    source_path: source,
    source_size_bytes: fileInfo.size,
    source_file_mtime: fileInfo.mtime.toISOString(),
    rows: null,
    columns: null,
    size_bytes: fileInfo.size,
    file_mtime: fileInfo.mtime.toISOString(),
    data_asof: null,
    data_asof_column: null,
    sha256: null,
    read_only: (fileInfo.mode & 0o222) === 0,
    max_age_hours: datasetLimit(spec, requirements, settings),
    age_hours: null,
    fresh: false,
    basis: 'file_mtime',
  }
  let probe
  try {
    probe = await probeFile(settings, destination, spec.dateColumns, signal)
  } catch (error) {
    if (spec.required) throw error
    record.probe_warning = messageOf(error)
  }
  if (probe) {
    record.rows = probe.rows ?? null
    record.columns = Array.isArray(probe.columns) ? probe.columns.length : null
    const cutoff = latestCutoff(probe, spec.dateColumns, now)
    if (cutoff) {
      record.data_asof = cutoff.at
      record.data_asof_column = cutoff.column
      record.basis = 'data_asof'
    }
  }
  record.sha256 = await sha256(destination, signal)
  const age = ageOf(record.data_asof ?? record.file_mtime, now)
  record.age_hours = age ?? null
  record.fresh = age !== undefined && age <= record.max_age_hours
  return record
}

async function copyDefinitions(settings, definitionRoot, requirements, directory, signal) {
  const records = {}
  for (const id of requirements.definitions) {
    const definition = settings.definitions.find((item) => item.id === id)
    if (!definition) throw new Error(`未知口径定义：${id}；可用：${settings.definitions.map((item) => item.id).join('、')}`)
    const source = sourcePath({ businessRoot: definitionRoot }, definition.path)
    const relative = isAbsolute(definition.path) ? definition.id + extname(definition.path) : definition.path
    const destination = join(directory, 'definitions', relative)
    await copyReadOnly(source, destination, signal, settings.copyTimeoutMs)
    const info = await stat(destination)
    records[id] = {
      id,
      label: definition.label,
      path: destination,
      source_path: source,
      size_bytes: info.size,
      mtime: info.mtime.toISOString(),
      sha256: await sha256(destination, signal),
      read_only: (info.mode & 0o222) === 0,
    }
  }
  return records
}

function manifestOf({ id, directory, origin, mode, settings, definitionRoot, requirements, datasets, definitions, now, warnings, subject }) {
  const coverage = coverageOf(requirements, Object.keys(datasets), Object.keys(definitions))
  return {
    manifest_version: MANIFEST_VERSION,
    version: id,
    id,
    created_at: nowIso(now),
    generator: `dsh-data-prep/${VERSION}`,
    origin,
    mode,
    directory,
    business_root: settings.businessRoot,
    definition_root: definitionRoot,
    requirements: {
      profile: requirements.profile,
      datasets: requirements.datasets,
      definitions: requirements.definitions,
      max_age_hours: requirements.maxAgeHours,
      description: requirements.description,
    },
    datasets,
    definitions,
    coverage,
    warnings,
    ...(subject ? { subject } : {}),
  }
}

function limitByCatalog(catalog) {
  return new Map(catalog.datasets.map((dataset) => [dataset.id, dataset]))
}

async function verifyManifest(settings, manifest, datasetIds, definitionIds, signal) {
  const directory = manifest.directory
  const mismatches = []
  for (const id of datasetIds) {
    const entry = manifest.datasets?.[id]
    if (!entry) {
      mismatches.push({ kind: 'dataset', id, reason: '清单中没有该数据集' })
      continue
    }
    const path = isAbsolute(entry.path) ? entry.path : resolve(directory, entry.path)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) {
      mismatches.push({ kind: 'dataset', id, reason: `文件不存在：${path}` })
      continue
    }
    if (info.size !== entry.size_bytes) mismatches.push({ kind: 'dataset', id, reason: `大小变化：${entry.size_bytes} -> ${info.size}` })
    if ((info.mode & 0o222) !== 0) mismatches.push({ kind: 'dataset', id, reason: '文件仍可写，不是只读快照' })
    if (entry.sha256) {
      const digest = await sha256(path, signal)
      if (digest !== entry.sha256) mismatches.push({ kind: 'dataset', id, reason: '内容哈希与清单不一致' })
    }
  }
  for (const id of definitionIds) {
    const entry = manifest.definitions?.[id]
    if (!entry) {
      mismatches.push({ kind: 'definition', id, reason: '清单中没有该口径定义' })
      continue
    }
    const path = isAbsolute(entry.path) ? entry.path : resolve(directory, entry.path)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) {
      mismatches.push({ kind: 'definition', id, reason: `文件不存在：${path}` })
      continue
    }
    if ((info.mode & 0o222) !== 0) mismatches.push({ kind: 'definition', id, reason: '文件仍可写，不是只读副本' })
    if (entry.sha256) {
      const digest = await sha256(path, signal)
      if (digest !== entry.sha256) mismatches.push({ kind: 'definition', id, reason: '内容哈希与清单不一致' })
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

/** True when a live source file is newer or otherwise different from the snapshot's read-only copy. */
async function sourceAdvanced(catalog, requirements, manifest, settings) {
  const byId = limitByCatalog(catalog)
  for (const id of requirements.datasets) {
    const spec = byId.get(id)
    const entry = manifest.datasets?.[id]
    if (!spec || !entry) return true
    const live = sourcePath(settings, spec.path)
    const liveInfo = await stat(live).catch(() => undefined)
    if (!liveInfo?.isFile()) continue
    const copy = isAbsolute(entry.path) ? entry.path : resolve(manifest.directory, entry.path)
    const copyInfo = await stat(copy).catch(() => undefined)
    if (!copyInfo?.isFile()) return true
    if (liveInfo.size !== copyInfo.size || Math.round(liveInfo.mtimeMs) !== Math.round(copyInfo.mtimeMs)) return true
  }
  return false
}

async function definitionsAdvanced(settings, definitionRoot, requirements, manifest, signal) {
  for (const id of requirements.definitions) {
    const definition = settings.definitions.find((item) => item.id === id)
    const entry = manifest.definitions?.[id]
    if (!definition || !entry) return true
    const source = sourcePath({ businessRoot: definitionRoot }, definition.path)
    const info = await stat(source).catch(() => undefined)
    if (!info?.isFile()) return true
    const digest = await sha256(source, signal)
    if (digest !== entry.sha256) return true
  }
  return false
}

function snapshotResult(manifest, requirements, settings, catalog, now, options) {
  const freshness = freshnessOf(manifest, requirements, settings, limitByCatalog(catalog), now)
  const coverage = coverageOf(requirements, Object.keys(manifest.datasets ?? {}), Object.keys(manifest.definitions ?? {}))
  const status = freshness.fresh ? 'ready' : 'stale'
  const refreshPlan = refreshPlanFor(catalog, requirements, freshness, settings)
  const consumer = requirements.consumer
  return {
    status,
    action: 'prepare',
    snapshot_id: manifest.id,
    directory: manifest.directory,
    reused: options.reused === true,
    derived: options.derived === true,
    snapshot: { ...manifest, directory: manifest.directory, freshness, coverage },
    coverage,
    freshness,
    ...(refreshPlan ? { refresh_plan: refreshPlan } : {}),
    ...(consumer ? { next: { tool: consumer.tool, arguments: { [consumer.argument]: manifest.directory } } } : {}),
    warnings: [...(manifest.warnings ?? [])],
  }
}

async function linkAnalysisSnapshot(settings, requirements, catalog, definitionRoot, snapshot, now, signal) {
  const manifest = await readJson(join(snapshot.directory, 'snapshot.json'))
  if (!manifest?.datasets) return undefined
  if (await sourceAdvanced(catalog, requirements, { ...manifest, directory: snapshot.directory }, settings)) return undefined

  const datasets = {}
  for (const id of requirements.datasets) {
    const entry = manifest.datasets[id]
    if (!entry) return undefined
    const path = isAbsolute(entry.path) ? entry.path : resolve(snapshot.directory, entry.path)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) return undefined
    if ((info.mode & 0o222) !== 0) return undefined
    const spec = catalog.datasets.find((dataset) => dataset.id === id) ?? { id, label: id, dateColumns: [] }
    const dataAsof = entry.data_asof ?? null
    const basis = dataAsof ?? entry.file_mtime ?? info.mtime.toISOString()
    const age = ageOf(basis, now)
    datasets[id] = {
      id,
      label: entry.label ?? spec.label ?? id,
      path,
      required: entry.required ?? spec.required ?? false,
      source_path: sourcePath(settings, spec.path),
      source_size_bytes: info.size,
      source_file_mtime: info.mtime.toISOString(),
      rows: entry.rows ?? null,
      columns: Array.isArray(entry.columns) ? entry.columns.length : entry.columns ?? null,
      size_bytes: info.size,
      file_mtime: entry.file_mtime ?? info.mtime.toISOString(),
      data_asof: dataAsof,
      data_asof_column: entry.data_asof_column ?? null,
      sha256: await sha256(path, signal),
      read_only: true,
      max_age_hours: datasetLimit(spec, requirements, settings),
      age_hours: age ?? null,
      fresh: age !== undefined && age <= datasetLimit(spec, requirements, settings),
      basis: dataAsof ? 'data_asof' : 'file_mtime',
    }
  }

  const id = randomUUID()
  const directory = join(settings.snapshotsDir, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const definitions = await copyDefinitions(settings, definitionRoot, requirements, directory, signal)
    const linked = manifestOf({
      id,
      directory,
      origin: 'analysis_snapshot',
      mode: 'link',
      settings,
      definitionRoot,
      requirements,
      datasets,
      definitions,
      now,
      warnings: [`数据集复用已授权刷新绑定的只读快照：${snapshot.version ?? snapshot.directory}`],
      subject: {
        kind: 'business_jobs_analysis_snapshot',
        version: snapshot.version ?? null,
        directory: snapshot.directory,
        trigger_id: snapshot.triggerId ?? snapshot.trigger_id ?? null,
        runs: snapshot.runs ?? [],
      },
    })
    linked.directory = directory
    const verification = await verifyManifest(settings, linked, requirements.datasets, requirements.definitions, signal)
    if (!verification.ok) throw new Error(`复用快照校验失败：${verification.mismatches.map((item) => item.reason).join('；')}`)
    await writeJsonAtomic(join(directory, 'snapshot.json'), linked)
    return snapshotResult(linked, requirements, settings, catalog, now, { reused: true, derived: true })
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function createSnapshot(settings, requirements, catalog, definitionRoot, now, signal) {
  const id = randomUUID()
  const directory = join(settings.snapshotsDir, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const byId = limitByCatalog(catalog)
    const datasets = {}
    const warnings = []
    for (const id of requirements.datasets) {
      signal?.throwIfAborted?.()
      const spec = byId.get(id)
      const source = sourcePath(settings, spec.path)
      const destination = join(directory, `${id}${extname(spec.path)}`)
      await copyReadOnly(source, destination, signal, settings.copyTimeoutMs)
      datasets[id] = await datasetRecord(settings, spec, destination, source, requirements, now, signal)
      if (datasets[id].probe_warning) warnings.push(`${id}: ${datasets[id].probe_warning}`)
    }
    const definitions = await copyDefinitions(settings, definitionRoot, requirements, directory, signal)
    const manifest = manifestOf({
      id,
      directory,
      origin: 'data_prep',
      mode: 'copy',
      settings,
      definitionRoot,
      requirements,
      datasets,
      definitions,
      now,
      warnings,
    })
    const verification = await verifyManifest(settings, manifest, requirements.datasets, requirements.definitions, signal)
    if (!verification.ok) throw new Error(`新快照自检失败：${verification.mismatches.map((item) => item.reason).join('；')}`)
    await writeJsonAtomic(join(directory, 'snapshot.json'), manifest)
    return snapshotResult(manifest, requirements, settings, catalog, now, { reused: false })
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function incompleteResult(requirements, missingDatasets, missingDefinitions, catalog) {
  return {
    status: 'incomplete',
    action: 'prepare',
    snapshot_id: null,
    coverage: coverageOf(requirements, [], []),
    missing_datasets: missingDatasets,
    missing_definitions: missingDefinitions,
    refresh_plan: missingDatasets.length
      ? {
          stale_datasets: missingDatasets.map((item) => item.id),
          jobs: catalog.jobs.filter((job) => job.datasets.some((id) => missingDatasets.some((item) => item.id === id))).map((job) => job.id),
          note: '先更新或补齐缺失的数据集，再调用 data_prepare。',
        }
      : undefined,
    warnings: [
      ...missingDatasets.map((item) => `数据集缺失：${item.id} (${item.path})`),
      ...missingDefinitions.map((item) => `口径定义缺失：${item.id} (${item.path})`),
    ],
  }
}

async function ensureSnapshot(settings, requirements, options, signal) {
  if (!settings.snapshotsDir) throw new Error('数据准备插件缺少 stateDir：设置 DSH_HOME/DSH_PROFILE 或插件 config.stateDir。')
  const catalog = await readCatalog(settings, signal)
  const byId = limitByCatalog(catalog)
  const unknownDatasets = requirements.datasets.filter((id) => !byId.has(id))
  if (unknownDatasets.length) throw new Error(`未知数据集：${unknownDatasets.join('、')}；可用：${[...byId.keys()].join('、')}`)
  const unknownDefinitions = requirements.definitions.filter((id) => !settings.definitions.some((item) => item.id === id))
  if (unknownDefinitions.length) throw new Error(`未知口径定义：${unknownDefinitions.join('、')}；可用：${settings.definitions.map((item) => item.id).join('、')}`)
  const definitionRoot = resolve(options.definitionRoot ?? settings.businessRoot)
  const now = options.now ?? new Date()

  const missingDatasets = requirements.datasets
    .map((id) => byId.get(id))
    .filter((spec) => !existsSync(sourcePath(settings, spec.path)))
    .map((spec) => ({ id: spec.id, label: spec.label, path: sourcePath(settings, spec.path) }))
  const missingDefinitions = requirements.definitions
    .map((id) => settings.definitions.find((item) => item.id === id))
    .filter((definition) => !existsSync(sourcePath({ businessRoot: definitionRoot }, definition.path)))
    .map((definition) => ({ id: definition.id, path: sourcePath({ businessRoot: definitionRoot }, definition.path) }))
  if (missingDatasets.length || missingDefinitions.length) {
    return incompleteResult(requirements, missingDatasets, missingDefinitions, catalog)
  }

  if (options.snapshotId) {
    const manifest = await readSnapshotById(settings, options.snapshotId)
    const providedDatasets = Object.keys(manifest.datasets ?? {})
    const providedDefinitions = Object.keys(manifest.definitions ?? {})
    const missingPinned = requirements.datasets.filter((id) => !providedDatasets.includes(id))
      .concat(requirements.definitions.filter((id) => !providedDefinitions.includes(id)))
    if (missingPinned.length) throw new Error(`快照 ${options.snapshotId} 不覆盖需求：${missingPinned.join('、')}`)
    const verification = await verifyManifest(settings, manifest, requirements.datasets, requirements.definitions, signal)
    if (!verification.ok) throw new Error(`快照 ${options.snapshotId} 校验失败：${verification.mismatches.map((item) => item.reason).join('；')}`)
    return snapshotResult(manifest, requirements, settings, catalog, now, { reused: true })
  }

  const warnings = []
  const manifests = await listSnapshotManifests(settings)
  const analyses = settings.reuseAnalysisSnapshots ? await listAnalysisSnapshots(settings) : []
  const candidates = [
    ...manifests.map((manifest) => ({ kind: 'data_prep', created_at: manifest.created_at, manifest })),
    ...analyses.map((snapshot) => ({ kind: 'analysis_snapshot', created_at: snapshot.created_at, snapshot })),
  ].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))

  for (const candidate of candidates) {
    signal?.throwIfAborted?.()
    if (candidate.kind === 'data_prep') {
      const manifest = candidate.manifest
      const providedDatasets = Object.keys(manifest.datasets ?? {})
      if (requirements.datasets.some((id) => !providedDatasets.includes(id))) continue
      const providedDefinitions = Object.keys(manifest.definitions ?? {})
      if (requirements.definitions.some((id) => !providedDefinitions.includes(id))) continue
      if (await sourceAdvanced(catalog, requirements, manifest, settings)) continue
      if (requirements.definitions.length && await definitionsAdvanced(settings, definitionRoot, requirements, manifest, signal)) continue
      const verification = await verifyManifest(settings, manifest, requirements.datasets, requirements.definitions, signal)
      if (!verification.ok) {
        warnings.push(`跳过已损坏的快照 ${manifest.id}：${verification.mismatches.slice(0, 3).map((item) => item.reason).join('；')}`)
        continue
      }
      const result = snapshotResult(manifest, requirements, settings, catalog, now, { reused: true })
      result.warnings = [...warnings, ...result.warnings]
      return result
    }
    const linked = await linkAnalysisSnapshot(settings, requirements, catalog, definitionRoot, candidate.snapshot, now, signal)
    if (linked) {
      linked.warnings = [...warnings, ...linked.warnings]
      return linked
    }
  }

  const created = await createSnapshot(settings, requirements, catalog, definitionRoot, now, signal)
  created.warnings = [...warnings, ...created.warnings]
  return created
}

async function readSnapshotById(settings, snapshotId) {
  if (!settings.snapshotsDir) throw new Error('数据准备插件缺少 stateDir：设置 DSH_HOME/DSH_PROFILE 或插件 config.stateDir。')
  const id = String(snapshotId ?? '').trim()
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error(`快照 id 非法：${snapshotId}`)
  const directory = join(settings.snapshotsDir, id)
  const manifest = await readJson(join(directory, 'snapshot.json'))
  if (!manifest) throw new Error(`快照不存在：${id}`)
  if (manifest.id !== id) throw new Error(`快照清单与 id 不一致：${id}`)
  return { ...manifest, directory }
}

async function statusResult(settings, declared, args, options, signal) {
  const catalog = await readCatalog(settings, signal)
  const now = new Date()
  const probeLive = args.probe === true
  const datasetStatus = []
  for (const spec of catalog.datasets) {
    datasetStatus.push(await inspectLiveDataset(settings, spec, now, probeLive, signal))
  }
  const definitionStatus = []
  for (const definition of settings.definitions) {
    definitionStatus.push(await inspectLiveDefinition(settings, definition, options.definitionRoot, signal))
  }
  const snapshots = (await listSnapshotManifests(settings)).slice(0, Math.min(Number(args.snapshots) || 5, 20)).map(summarize)
  const profiles = profilesOf(settings, declared)
    .map((profile) => ({
      name: profile.name,
      source: profile.source,
      datasets: profile.datasets,
      definitions: profile.definitions,
      consumer: profile.consumer,
      description: profile.description,
    }))
  return {
    status: 'ok',
    action: 'status',
    catalog: {
      business_root: settings.businessRoot,
      definition_root: options.definitionRoot,
      snapshots_dir: settings.snapshotsDir,
      datasets: datasetStatus,
      definitions: definitionStatus,
      jobs: catalog.jobs,
      requirements: profiles,
    },
    snapshots,
    warnings: [
      ...datasetStatus.flatMap((dataset) => dataset.warnings),
      ...definitionStatus.flatMap((definition) => definition.warnings),
    ],
  }
}

async function verifyById(settings, snapshotId, signal) {
  const manifest = await readSnapshotById(settings, snapshotId)
  const verification = await verifyManifest(settings, manifest, Object.keys(manifest.datasets ?? {}), Object.keys(manifest.definitions ?? {}), signal)
  return {
    status: verification.ok ? 'verified' : 'invalid',
    action: 'verify',
    snapshot_id: manifest.id,
    directory: manifest.directory,
    checked: { datasets: Object.keys(manifest.datasets ?? {}).length, definitions: Object.keys(manifest.definitions ?? {}).length },
    mismatches: verification.mismatches,
    snapshot: summarize({ ...manifest, directory: manifest.directory }),
  }
}

function displayTime(value) {
  if (!value) return '-'
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return String(value)
  const date = new Date(at)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortHash(value) {
  return typeof value === 'string' ? value.slice(0, 12) : '-'
}

function renderStatus(value) {
  const catalog = value.catalog
  const lines = [`数据集清单（${catalog.datasets.length} 个，业务仓库 ${catalog.business_root}）`]
  lines.push('')
  lines.push('| 数据集 | 行数 | 数据截止 | 文件更新 | 新鲜度 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const dataset of catalog.datasets) {
    const cutoff = dataset.data_asof ? `${displayTime(dataset.data_asof)} (${dataset.data_asof_column})` : '未读取'
    const age = dataset.age_hours === null ? '-' : `${dataset.age_hours}h / ${dataset.max_age_hours}h`
    lines.push(`| ${dataset.label} (${dataset.id}) | ${dataset.rows ?? '-'} | ${cutoff} | ${displayTime(dataset.file_mtime)} | ${dataset.exists ? (dataset.fresh ? 'OK' : `过期，${age}`) : '缺失'} |`)
  }
  lines.push('')
  lines.push(`口径定义（${catalog.definition_root}）：${catalog.definitions.map((definition) => `${definition.id}${definition.exists ? '' : '（缺失）'}`).join('、')}`)
  const requirementLines = catalog.requirements.map((profile) => `${profile.name}（${profile.source}）→ ${profile.datasets.join('、') || '-'}${profile.definitions.length ? `；口径 ${profile.definitions.join('、')}` : ''}`)
  if (requirementLines.length) lines.push(`分析需求：${requirementLines.join('；')}`)
  if (value.snapshots.length) {
    lines.push('')
    lines.push(`最近快照（${value.snapshots.length} 个）：`)
    for (const snapshot of value.snapshots) {
      lines.push(`- ${snapshot.id}（${displayTime(snapshot.created_at)}，${snapshot.origin}/${snapshot.mode}）：${snapshot.datasets.join('、')}${snapshot.subject ? `；来自 ${snapshot.subject.version ?? snapshot.subject.directory}` : ''}`)
    }
  }
  if (value.warnings.length) {
    lines.push('')
    lines.push(`提示：${value.warnings.slice(0, 5).join('；')}`)
  }
  return lines.join('\n')
}

function renderPrepare(value) {
  if (value.status === 'incomplete') {
    const lines = [`数据准备未完成：${value.warnings.join('；')}`]
    if (value.refresh_plan?.note) lines.push(value.refresh_plan.note)
    return lines.join('\n')
  }
  const snapshot = value.snapshot
  const title = value.reused
    ? (value.derived ? '复用已授权刷新快照' : '复用现有快照')
    : '新建只读快照'
  const lines = [`数据快照 ${value.snapshot_id} 已就绪（${title}）：${value.coverage.provided_datasets.length}/${value.coverage.required_datasets.length} 数据集，${value.coverage.provided_definitions.length}/${value.coverage.required_definitions.length} 口径定义；新鲜度${value.freshness.fresh ? '通过' : '过期'}`]
  lines.push('')
  lines.push('| 数据集 | 行数 | 数据截止 | 文件更新 | 状态 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const id of Object.keys(snapshot.datasets)) {
    const dataset = snapshot.datasets[id]
    const cutoff = dataset.data_asof ? `${displayTime(dataset.data_asof)} (${dataset.data_asof_column})` : `${displayTime(dataset.file_mtime)} (文件时间)`
    lines.push(`| ${dataset.label} (${id}) | ${dataset.rows ?? '-'} | ${cutoff} | ${displayTime(dataset.file_mtime)} | ${dataset.fresh ? '新鲜' : `超过 ${dataset.max_age_hours}h`} |`)
  }
  const definitions = Object.values(snapshot.definitions)
  if (definitions.length) {
    lines.push('')
    lines.push(`口径定义：${definitions.map((definition) => `${definition.id}@${shortHash(definition.sha256)}`).join('、')}`)
  }
  lines.push('')
  lines.push(`目录：${value.directory}`)
  for (const [id, dataset] of Object.entries(snapshot.datasets)) lines.push(`- ${id}: ${dataset.path}`)
  if (value.next) {
    lines.push(`下一步：调用 ${value.next.tool}，并把 ${Object.keys(value.next.arguments)[0]} 设为上面的目录。`)
  }
  if (value.refresh_plan) {
    lines.push('')
    lines.push(`数据已过期：${value.refresh_plan.stale_datasets.join('、')}。${value.refresh_plan.note}`)
    if (value.refresh_plan.recommended_business_job) {
      lines.push(`可用 business_job：${JSON.stringify(value.refresh_plan.recommended_business_job)}`)
    }
    if (value.refresh_plan.uncovered_datasets?.length) {
      lines.push(`无已登记 Job 的数据集：${value.refresh_plan.uncovered_datasets.join('、')}。`)
    }
  }
  if (value.warnings.length) {
    lines.push('')
    lines.push(`提示：${value.warnings.slice(0, 5).join('；')}`)
  }
  return lines.join('\n')
}

function renderVerify(value) {
  if (value.status === 'verified') {
    return `快照 ${value.snapshot_id} 校验通过：${value.checked.datasets} 个数据集、${value.checked.definitions} 个口径定义均为只读且哈希一致。\n目录：${value.directory}`
  }
  return [`快照 ${value.snapshot_id} 校验失败：`, ...value.mismatches.map((item) => `- ${item.kind}/${item.id}：${item.reason}`)].join('\n')
}

function renderResult(_args, value) {
  if (value?.action === 'status') return [{ type: 'text', text: renderStatus(value) }]
  if (value?.action === 'verify') return [{ type: 'text', text: renderVerify(value) }]
  return [{ type: 'text', text: renderPrepare(value) }]
}

const TOOL_DESCRIPTION = [
  '为分析插件准备只读数据快照：按数据集清单和权威口径定义，复用或创建一致性快照，返回快照 ID、目录、覆盖率、各表行数与数据截止时间。',
  'status 只读列出项目内全部数据集、新鲜度、口径定义与分析插件已声明的需求；',
  'prepare 按 profile（例如 order_config_ratio）或显式 datasets 准备快照，并给出可继续调用的分析工具与参数；',
  'verify 校验已有快照的文件与哈希。',
  '生产数据刷新不在本工具内执行：过期时返回 refresh_plan，由已授权的 business_job 刷新后再次 prepare。',
].join('')

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'prepare', 'verify'],
      description: 'status 只读查看；prepare 复用或创建快照；verify 校验指定快照。',
    },
    profile: {
      type: 'string',
      description: '已声明的需求名，如 order_config_ratio、lock_analysis、all。与 datasets 二选一；同时给出时 datasets 覆盖 profile 的数据集。',
    },
    datasets: {
      type: 'array',
      items: { type: 'string' },
      description: '数据集 ID 列表，如 order_data、config_attribute；传 all 表示全部数据集。',
    },
    definitions: {
      type: 'array',
      items: { type: 'string' },
      description: '口径定义 ID，如 business_definition、metrics、config_semantics。省略时用 profile 的声明。',
    },
    max_age_hours: {
      type: 'number',
      description: '新鲜度阈值（小时）；超过阈值的快照仍会复用并标记 stale，同时返回刷新计划。默认使用插件配置。',
    },
    snapshot_id: {
      type: 'string',
      description: 'verify 必填；prepare 时表示固定复用该快照。',
    },
    probe: {
      type: 'boolean',
      description: 'status 时是否读取各表日期列以得到业务截止时间；默认 false 只看文件更新时间，true 会明显更慢。',
    },
    snapshots: {
      type: 'number',
      description: 'status 时列出最近多少个快照，默认 5。',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

export function apply(ctx, config = {}) {
  const settings = settingsOf(config)
  const declared = new Map()

  const service = {
    /**
     * Prepare or reuse one read-only snapshot for a requirement profile or an
     * explicit requirement object. Data conditions (a missing file) return
     * `status: 'incomplete'`; operational errors throw.
     * @param {string | { profile?: string, datasets?: string[], definitions?: string[], maxAgeHours?: number }} requirements
     * @param {{ snapshotId?: string, definitionRoot?: string, cwd?: string }} [options]
     */
    async ensure(requirements, options = {}) {
      const catalog = await readCatalog(settings, options.signal)
      const resolved = resolveRequirements(requirements, settings, catalog, profilesOf(settings, declared))
      return await ensureSnapshot(settings, resolved, {
        snapshotId: options.snapshotId ?? options.snapshot_id,
        definitionRoot: options.definitionRoot ?? options.definition_root ?? chooseDefinitionRoot(options.cwd, settings),
      }, options.signal)
    },
    /** Live dataset and definition status plus declared requirements and recent snapshots. */
    async catalog(options = {}) {
      const definitionRoot = options.definitionRoot ?? options.definition_root ?? chooseDefinitionRoot(options.cwd, settings)
      return await statusResult(settings, declared, { probe: options.probe === true, snapshots: options.snapshots }, { definitionRoot }, options.signal)
    },
    /** Verify one snapshot's files, permissions and hashes. */
    async verify(snapshotId, options = {}) {
      return await verifyById(settings, snapshotId, options.signal)
    },
    /** Recent data-prep snapshots, newest first. */
    async list(limit = 10) {
      return (await listSnapshotManifests(settings)).slice(0, limit).map(summarize)
    },
    /** Declare an analysis plugin's data requirements; returns a disposer. */
    declare(profile, requirements) {
      const key = String(profile ?? '').trim()
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`需求名非法：${profile}`)
      declared.set(key, normalizeProfile(key, requirements))
      return () => {
        if (declared.has(key)) declared.delete(key)
      }
    },
    /** Every known requirement profile, with its source. */
    requirements() {
      return profilesOf(settings, declared).map((profile) => ({
        name: profile.name,
        source: profile.source,
        datasets: profile.datasets,
        definitions: profile.definitions,
        consumer: profile.consumer,
        description: profile.description,
      }))
    },
  }

  ctx.provide('dataPreparation', service)

  const definition = {
    name: 'data_prepare',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderResult,
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const action = String(args?.action ?? '').trim()
      if (!['status', 'prepare', 'verify'].includes(action)) throw new Error('action 必须是 status、prepare 或 verify。')
      const signal = execution?.signal ?? new AbortController().signal
      let cwd
      try {
        const workingDirectory = ctx.get('workingDirectory')
        if (execution?.agent && workingDirectory) cwd = await workingDirectory.ensure(execution.agent, signal)
      } catch {
        cwd = undefined
      }
      if (action === 'status') {
        return lossless(await service.catalog({ cwd, probe: args.probe, snapshots: args.snapshots, signal }))
      }
      if (action === 'verify') {
        if (!args.snapshot_id) throw new Error('verify 需要 snapshot_id。')
        return lossless(await service.verify(args.snapshot_id, { signal }))
      }
      return lossless(await service.ensure(
        { profile: args.profile, datasets: args.datasets, definitions: args.definitions, max_age_hours: args.max_age_hours },
        { cwd, snapshotId: args.snapshot_id, signal },
      ))
    },
  }
  ctx.effect(() => ctx.tools.register(definition))

  ctx.logger?.info?.('data-prep ready: businessRoot=%s stateDir=%s', settings.businessRoot, settings.stateDir || '(unset)')
}
