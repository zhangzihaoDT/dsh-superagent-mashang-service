/** Prepares a ticket's clean git worktree and its read-only shared data, recording provenance, cutoff and timing. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { packagePath } from '../infra/paths.ts'

/** A repository-relative path without parent traversal. */
const RelativePath = z.string().trim().min(1).refine(path => !isAbsolute(path) && !path.split('/').includes('..'),
  'Expected a repository-relative path without ".."')
/** Which columns carry the data cutoff, and whether a cutoff must be found. */
const CutoffSchema = z.object({
  columns: z.array(z.string().trim().min(1)).default([]),
  required: z.boolean().default(true),
}).strict()
/** One file a business repository shares with ticket worktrees. */
export const SharedDataSchema = z.object({
  path: RelativePath,
  required: z.boolean().default(true),
  readOnly: z.boolean().default(true),
  maxAgeHours: z.number().positive().optional(),
  cutoff: CutoffSchema.optional(),
  notes: z.string().default(''),
}).strict()
export type SharedData = z.infer<typeof SharedDataSchema>
/** A command that reads one file's row count, columns and cutoff values; it receives a JSON request on stdin. */
const ProbeSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().default(120_000),
}).strict()
/** A read-only entry point the business repository already provides for one kind of question. */
const OfficialQuerySchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().default(''),
  command: z.array(z.string().min(1)).min(1),
  notes: z.string().default(''),
  contract: z.object({
    appliesTo: z.string().trim().min(1),
    arguments: z.array(z.string().min(1)),
    parameters: z.record(z.string().min(1), z.string().min(1)),
    references: z.array(RelativePath),
    result: z.object({
      file: z.string().min(1),
      collection: z.string().min(1),
      match: z.record(z.string().min(1), z.string().min(1)),
      fields: z.record(z.string().min(1), z.string().min(1)),
    }).strict(),
    checks: z.array(z.string().min(1)).min(1),
    investigateWhen: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
}).strict()
export type OfficialQuery = z.infer<typeof OfficialQuerySchema>
/**
 * A deployment's description of one business repository: where its clean checkout and data live, which data
 * it declares, how to probe that data's cutoff, and which official query entries workers should prefer.
 * The repository path is configuration, never a constant of the Harness.
 */
export const PrepareProfileSchema = z.object({
  version: z.literal(1).default(1),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'Expected owner/name').optional(),
  checkout: z.string().trim().min(1),
  dataRoot: z.string().trim().min(1).optional(),
  baseRef: z.string().trim().min(1).default('HEAD'),
  branchPrefix: z.string().min(1).default('agent/'),
  fetch: z.boolean().default(false),
  clean: z.boolean().default(true),
  python: z.string().trim().min(1).default('python3'),
  probe: ProbeSchema.optional(),
  declare: z.object({
    command: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().default(60_000),
  }).strict().optional(),
  freshness: z.object({ maxAgeHours: z.number().positive().optional() }).strict().default({}),
  data: z.array(SharedDataSchema).default([]),
  officialQueries: z.array(OfficialQuerySchema).default([]),
}).strict()
export type PrepareProfile = z.infer<typeof PrepareProfileSchema>

/** A ticket directory preparation failed, with a message a person and the ticket can act on. */
export class PrepareError extends Error {
  constructor(message: string) { super(message); this.name = 'PrepareError' }
}
/** The ticket being prepared; its directory is where the worktree is created. */
export interface PrepareTicket { id: string; name: string; directory: string }
/** The timing of one preparation, including the phases that took the most time. */
export interface PrepareTiming {
  startedAt: string
  finishedAt: string
  durationMs: number
  phases: Record<string, number>
}
/** One data file as prepared into the worktree. */
export interface PreparedData {
  path: string
  sourcePath: string
  mode: 'git' | 'clone' | 'copy'
  readOnly: boolean
  bytes: number
  mtime: string
  sha256: string
  rows?: number
  columns?: number
  cutoff?: { at: string; column: string }
  ageHours?: number
  maxAgeHours?: number
  fresh?: boolean
  notes: string
}
/** The durable record of a ticket's prepared workspace, read by its worker and kept for audit. */
export interface PrepareRecord {
  version: 1
  status: 'ready' | 'failed'
  preparedAt: string
  ticket: PrepareTicket
  source: {
    repository?: string
    checkout: string
    dataRoot: string
    baseRef: string
    baseCommit: string
    head: string
    clean: boolean
    dataRootTrackedDirty?: boolean
  }
  worktree: { directory: string; branch: string; head: string; clean: boolean }
  data: PreparedData[]
  officialQueries: OfficialQuery[]
  warnings: string[]
  timing: PrepareTiming
  error?: string
}
/** Everything `prepareWorkspace` needs; tests pass a profile directly, the CLI reads one from disk. */
export interface PrepareOptions {
  profile?: PrepareProfile
  profilePath?: string
  profilesDir?: string
  ticket?: PrepareTicket
  recordPath?: string
  env?: NodeJS.ProcessEnv
  now?: Date
}
/** Where the record is written and the parsed workspace profile it was prepared from. */
export interface PrepareResult { record: PrepareRecord; recordPath: string; profilePath?: string }

interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
/** Runs one command and rejects with a `PrepareError` that names it and its stderr when it fails. */
async function run(file: string, args: string[], options: RunOptions = {}): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim() || error.message
        reject(new PrepareError(`\`${file} ${args.join(' ')}\` failed: ${detail}`))
        return
      }
      resolvePromise(String(stdout))
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}
const pathExists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)
const inside = (parent: string, child: string): boolean => {
  const relativePath = relative(parent, child)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const hour = 3_600_000

async function loadProfile(options: PrepareOptions, env: NodeJS.ProcessEnv): Promise<{ profile: PrepareProfile; profilePath?: string }> {
  if (options.profile) return { profile: PrepareProfileSchema.parse(options.profile) }
  let path = options.profilePath
  if (!path && options.profilesDir) {
    const repository = env.DSH_SUPERAGENT_GITHUB_REPOSITORY?.trim()
    const named = repository ? join(options.profilesDir, `${repository.replace('/', '__')}.json`) : undefined
    const fallback = join(options.profilesDir, 'default.json')
    path = named && existsSync(named) ? named : fallback
  }
  if (!path) throw new PrepareError('No workspace profile was given; pass --profile or --profiles-dir')
  const parsed = PrepareProfileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return { profile: parsed, profilePath: path }
}

/** Runs the profile's declaration command in the clean checkout and returns the shared-data items it declared. */
async function declaredData(profile: PrepareProfile, checkout: string, env: NodeJS.ProcessEnv): Promise<SharedData[]> {
  if (!profile.declare) return []
  const [file, ...args] = profile.declare.command
  if (!file) throw new PrepareError('The declaration command is empty')
  let output: string
  try {
    output = await run(file, args, { cwd: checkout, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, timeoutMs: profile.declare.timeoutMs })
  } catch (error) {
    throw new PrepareError(`The business repository's data declaration failed: ${messageOf(error)}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { throw new PrepareError('The business repository\'s data declaration did not print JSON') }
  if (!Array.isArray(parsed)) throw new PrepareError('The business repository\'s data declaration must print a JSON array')
  return parsed.map((item, index) => {
    try { return SharedDataSchema.parse(item) } catch (error) { throw new PrepareError(`Data declaration ${index + 1} is invalid: ${messageOf(error)}`) }
  })
}

/** Merges declared and explicitly configured data by path, with the profile's explicit entries taking precedence. */
function mergeData(profile: PrepareProfile, declared: SharedData[]): SharedData[] {
  const byPath = new Map<string, SharedData>()
  for (const item of [...declared, ...profile.data]) byPath.set(item.path, item)
  return [...byPath.values()]
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/** Copies a data file into the worktree, preferring an APFS clone, then a plain copy, and makes it read-only. */
async function copyData(source: string, destination: string, readOnly: boolean): Promise<'clone' | 'copy'> {
  await mkdir(dirname(destination), { recursive: true })
  let copyMode: 'clone' | 'copy' = 'clone'
  try {
    await run('cp', ['-c', '-p', '--', source, destination], { timeoutMs: 120_000 })
  } catch {
    copyMode = 'copy'
    try {
      await run('cp', ['-p', '--', source, destination], { timeoutMs: 120_000 })
    } catch {
      await copyFile(source, destination)
      const sourceStat = await stat(source)
      await utimes(destination, sourceStat.atime, sourceStat.mtime)
    }
  }
  if (readOnly) await chmod(destination, 0o444)
  else await chmod(destination, 0o644)
  return copyMode
}

interface ProbeResult { rows?: number; columns?: string[]; cutoffs?: { column: string; at: string }[] }
/** Runs the configured probe over one prepared file; its JSON output supplies rows, columns and cutoff values. */
async function probeData(probe: NonNullable<PrepareProfile['probe']>, path: string, columns: string[], now: Date): Promise<ProbeResult> {
  const [file, ...args] = probe.command
  if (!file) throw new PrepareError('The data probe command is empty')
  let output: string
  try {
    output = await run(file, args, { cwd: dirname(path), timeoutMs: probe.timeoutMs, input: JSON.stringify({ path, columns, now: now.toISOString() }) })
  } catch (error) {
    throw new PrepareError(`The data probe failed for ${path}: ${messageOf(error)}`)
  }
  let parsed: ProbeResult & { error?: string }
  try { parsed = JSON.parse(output) as ProbeResult & { error?: string } } catch { throw new PrepareError(`The data probe for ${path} did not print JSON`) }
  if (parsed.error) throw new PrepareError(`The data probe for ${path} failed: ${parsed.error}`)
  return parsed
}

/** Writes a record atomically so a reader never sees a half-written workspace description. */
async function writeRecord(path: string, record: PrepareRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
}

/**
 * Creates a clean git worktree for a ticket from a clean source checkout, copies the business repository's
 * declared shared data into it read-only, checks each file's cutoff and freshness, and records the result.
 * A missing data file, an unknown cutoff, a stale file or a dirty source checkout fails with a `PrepareError`
 * before the worker starts. The source checkout is only read; data may come from a separate data root.
 */
export async function prepareWorkspace(options: PrepareOptions = {}): Promise<PrepareResult> {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const started = now.getTime()
  const phases: Record<string, number> = {}
  const warnings: string[] = []
  let phase = started
  const mark = (name: string): void => { const at = Date.now(); phases[name] = Math.max(0, at - phase); phase = at }
  const { profile, profilePath } = await loadProfile(options, env)
  const ticketRepository = env.DSH_SUPERAGENT_GITHUB_REPOSITORY?.trim()
  if (profile.repository && ticketRepository && profile.repository !== ticketRepository) {
    throw new PrepareError(`The workspace profile is for ${profile.repository}, but this ticket is for ${ticketRepository}`)
  }
  const ticket: PrepareTicket = options.ticket ?? {
    id: env.DSH_SUPERAGENT_TICKET?.trim() ?? '',
    name: env.DSH_SUPERAGENT_NAME?.trim() ?? '',
    directory: env.DSH_SUPERAGENT_DIR?.trim() ?? '',
  }
  if (!ticket.id || !ticket.name || !ticket.directory) throw new PrepareError('A ticket id, name and directory are required')
  ticket.directory = resolve(ticket.directory)
  const recordPath = resolve(options.recordPath ?? env.DSH_SUPERAGENT_PREPARE_RECORD ?? join(dirname(ticket.directory), `${ticket.name}.prepare.json`))
  const requestedCheckout = resolve(profile.checkout)
  if (!await pathExists(requestedCheckout)) throw new PrepareError(`The source checkout ${requestedCheckout} does not exist`)
  const checkout = await realpath(requestedCheckout)
  const requestedDataRoot = resolve(profile.dataRoot ?? profile.checkout)
  const dataRoot = await pathExists(requestedDataRoot) ? await realpath(requestedDataRoot) : requestedDataRoot
  const source: PrepareRecord['source'] = { repository: profile.repository, checkout, dataRoot,
    baseRef: profile.baseRef, baseCommit: '', head: '', clean: false }
  const worktree: PrepareRecord['worktree'] = { directory: ticket.directory, branch: '', head: '', clean: false }
  const data: PreparedData[] = []
  let createdWorktree = false
  const partial = (): PrepareRecord => ({ version: 1, status: 'failed', preparedAt: new Date().toISOString(), ticket, source, worktree, data,
    officialQueries: profile.officialQueries, warnings, error: '',
    timing: { startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, phases } })
  try {
    if (!await pathExists(checkout)) throw new PrepareError(`The source checkout ${checkout} does not exist`)
    const root = (await run('git', ['-C', checkout, 'rev-parse', '--show-toplevel'])).trim()
    if (resolve(root) !== checkout) throw new PrepareError(`${checkout} is not the root of its git checkout (${root})`)
    source.head = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).trim()
    const dirty = (await run('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'])).trim()
    source.clean = !dirty
    if (profile.clean && dirty) {
      const lines = dirty.split('\n').slice(0, 20).join('\n')
      throw new PrepareError(`The source checkout ${checkout} has uncommitted tracked changes, so it cannot be a code execution environment:\n${lines}`)
    }
    if (profile.fetch) await run('git', ['-C', checkout, 'fetch', '--no-tags', 'origin'], { timeoutMs: 120_000 })
    source.baseCommit = (await run('git', ['-C', checkout, 'rev-parse', '--verify', `${profile.baseRef}^{commit}`])).trim()
    source.dataRootTrackedDirty = await run('git', ['-C', dataRoot, 'status', '--porcelain', '--untracked-files=no'])
      .then(output => !!output.trim(), () => undefined)
    const items = mergeData(profile, await declaredData(profile, checkout, env))
    mark('inspect')

    const branch = `${profile.branchPrefix}${ticket.name}`
    worktree.branch = branch
    if (await pathExists(ticket.directory)) {
      const entries = await readdir(ticket.directory)
      if (entries.length) throw new PrepareError(`The ticket directory ${ticket.directory} already exists and is not empty`)
      await rmdir(ticket.directory)
    }
    const branchExists = await run('git', ['-C', checkout, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      .then(() => true, () => false)
    if (branchExists) throw new PrepareError(`The branch ${branch} already exists; use a new ticket name or remove that branch`)
    await mkdir(dirname(ticket.directory), { recursive: true })
    await run('git', ['-C', checkout, 'worktree', 'add', '-b', branch, ticket.directory, source.baseCommit], { timeoutMs: 120_000 })
    createdWorktree = true
    worktree.head = (await run('git', ['-C', ticket.directory, 'rev-parse', 'HEAD'])).trim()
    mark('worktree')

    const probe = profile.probe ?? (items.some(item => item.cutoff?.columns.length)
      ? { command: [profile.python, packagePath('scripts', 'probe-dataset.py')], timeoutMs: 120_000 } : undefined)
    for (const item of items) {
      const destination = resolve(ticket.directory, item.path)
      if (!inside(ticket.directory, destination)) throw new PrepareError(`The data path ${item.path} escapes the worktree`)
      const tracked = await run('git', ['-C', ticket.directory, 'ls-files', '--error-unmatch', '--', item.path])
        .then(() => true, () => false)
      const sourcePath = tracked ? destination : resolve(dataRoot, item.path)
      if (!tracked && !inside(dataRoot, sourcePath)) throw new PrepareError(`The data path ${item.path} escapes the data root`)
      if (!await pathExists(sourcePath)) {
        if (item.required) throw new PrepareError(`The declared data file ${item.path} is missing at ${sourcePath}`)
        warnings.push(`Optional data ${item.path} is missing at ${sourcePath}`)
        continue
      }
      if (!(await stat(sourcePath)).isFile()) {
        if (item.required) throw new PrepareError(`The declared data path ${item.path} is not a file at ${sourcePath}`)
        warnings.push(`Optional data ${item.path} is not a file at ${sourcePath}`)
        continue
      }
      const mode = tracked ? 'git' : await copyData(sourcePath, destination, item.readOnly)
      if (tracked && item.readOnly) await chmod(destination, 0o444)
      const destinationStat = await stat(destination)
      const prepared: PreparedData = { path: item.path, sourcePath, mode, readOnly: item.readOnly,
        bytes: destinationStat.size, mtime: destinationStat.mtime.toISOString(), sha256: await sha256(destination), notes: item.notes }
      if (item.readOnly && (destinationStat.mode & 0o222)) throw new PrepareError(`The prepared data ${item.path} is still writable`)
      if (probe && item.cutoff) {
        const result = await probeData(probe, destination, item.cutoff.columns, now)
        prepared.rows = result.rows
        prepared.columns = result.columns?.length
        const hits = (result.cutoffs ?? []).filter(hit => item.cutoff!.columns.includes(hit.column) && Date.parse(hit.at) <= now.getTime())
        const latest = hits.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1)
        if (latest) {
          prepared.cutoff = { at: latest.at, column: latest.column }
          prepared.ageHours = Math.round((now.getTime() - Date.parse(latest.at)) / hour * 100) / 100
        } else if (item.cutoff.required !== false) {
          throw new PrepareError(`Could not determine the data cutoff of ${item.path} from columns ${item.cutoff.columns.join(', ')}`)
        }
      }
      const maxAgeHours = item.maxAgeHours ?? profile.freshness.maxAgeHours
      if (maxAgeHours !== undefined) {
        if (!prepared.cutoff) throw new PrepareError(`The data ${item.path} has no cutoff, so its ${maxAgeHours}h freshness cannot be checked`)
        prepared.maxAgeHours = maxAgeHours
        prepared.fresh = (prepared.ageHours ?? Infinity) <= maxAgeHours
        if (!prepared.fresh) {
          throw new PrepareError(`The data ${item.path} is stale: cutoff ${prepared.cutoff.at} (${prepared.cutoff.column}) is ${prepared.ageHours}h old, above the ${maxAgeHours}h limit`)
        }
      }
      data.push(prepared)
    }
    mark('data')

    const trackedDirty = (await run('git', ['-C', ticket.directory, 'status', '--porcelain', '--untracked-files=no'])).trim()
    worktree.clean = !trackedDirty
    if (trackedDirty) throw new PrepareError(`The prepared worktree ${ticket.directory} has uncommitted tracked changes:\n${trackedDirty.split('\n').slice(0, 20).join('\n')}`)
    mark('verify')

    const record: PrepareRecord = { version: 1, status: 'ready', preparedAt: new Date().toISOString(), ticket, source, worktree, data,
      officialQueries: profile.officialQueries, warnings,
      timing: { startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, phases } }
    await writeRecord(recordPath, record)
    return { record, recordPath, ...profilePath ? { profilePath } : {} }
  } catch (error) {
    const failed = partial()
    failed.error = messageOf(error)
    failed.timing.finishedAt = new Date().toISOString()
    failed.timing.durationMs = Date.now() - started
    // Write the failure before removing the worktree so a record path inside it is not recreated by the write.
    await writeRecord(recordPath, failed).catch(() => { /* The original error is the one to report. */ })
    // A failed preparation must not leave a directory that a later launch would count as prepared.
    if (createdWorktree) {
      await rm(ticket.directory, { recursive: true, force: true }).catch(() => { /* Keep the original error. */ })
      await run('git', ['-C', checkout, 'worktree', 'prune']).catch(() => { /* Keep the original error. */ })
      if (worktree.branch) await run('git', ['-C', checkout, 'branch', '-D', worktree.branch]).catch(() => { /* Keep the original error. */ })
    }
    throw error instanceof PrepareError ? error : new PrepareError(messageOf(error))
  }
}
