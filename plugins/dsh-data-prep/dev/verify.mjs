/**
 * Offline end-to-end check for dsh-data-prep.
 *
 * It mounts the plugin on a minimal Context stand-in, then exercises the same
 * code paths the Harness calls: status, prepare, reuse, verify, and a real
 * query.py read of the produced snapshot. It writes only under the plugin's
 * configured state directory (a temporary directory by default).
 *
 *   node dev/verify.mjs [--state <dir>]
 */
import { mashangConfig } from './mashang-config.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { apply } from '../index.js'

const exec = promisify(execFile)
const args = process.argv.slice(2)
const stateIndex = args.indexOf('--state')
const STATE = stateIndex >= 0 ? resolve(args[stateIndex + 1]) : await mkdtemp(join(tmpdir(), 'dsh-data-prep-'))
const BUSINESS = process.env.DSH_SUPERAGENT_BUSINESS_ROOT?.trim()
  || join(process.env.HOME ?? '', 'Documents/github/mashang-service')
const QUERY = process.env.DSH_DATA_PREP_QUERY_PY?.trim()
  || new URL('../../order-config-ratio/query.py', import.meta.url).pathname

assert.ok(existsSync(join(BUSINESS, 'dataset/order_data.parquet')), `business dataset missing under ${BUSINESS}`)
assert.ok(existsSync(QUERY), `query.py missing at ${QUERY}`)

const services = new Map()
const tools = new Map()
const ctx = {
  effect: (factory) => {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  provide: (name, value) => {
    services.set(name, value)
    return () => services.delete(name)
  },
  get: (name) => services.get(name),
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

apply(ctx, mashangConfig(BUSINESS, STATE))
const tool = tools.get('data_prepare')
const service = services.get('dataPreparation')
assert.ok(tool, 'data_prepare tool was not registered')
assert.ok(service, 'dataPreparation service was not provided')
assert.equal(tool.parameters.required[0], 'action')

const execution = { signal: new AbortController().signal, agent: undefined }

console.log(`state: ${STATE}`)
console.log('--- status (no probe) ---')
const status = await tool.execute({ action: 'status' }, execution)
assert.equal(status.status, 'ok')
assert.ok(status.catalog.datasets.length >= 4, 'catalog should list the business datasets')
console.log(`datasets=${status.catalog.datasets.length} definitions=${status.catalog.definitions.length} profiles=${status.catalog.requirements.length}`)

console.log('--- declare an analysis requirement ---')
const dispose = service.declare('probe_profile', {
  datasets: ['order_data'],
  definitions: ['business_definition'],
  consumer: { tool: 'probe_analysis', argument: 'snapshot_dir' },
})
assert.ok(service.requirements().some((profile) => profile.name === 'probe_profile' && profile.source === 'declared'))

console.log('--- prepare order_config_ratio ---')
service.declare('order_config_ratio', {
  datasets: ['order_data', 'config_attribute'],
  definitions: ['business_definition', 'metrics', 'config_semantics'],
})

const leads = await tool.execute({ action: 'prepare', datasets: ['assign_data'], definitions: ['metrics'] }, execution)
assert.equal(leads.status, 'ready', JSON.stringify(leads.warnings))
assert.ok(leads.snapshot.datasets.assign_data.rows > 0)
assert.equal(leads.snapshot.datasets.assign_data.read_only, true)

const first = await tool.execute({ action: 'prepare', profile: 'order_config_ratio' }, execution)
assert.equal(first.status, 'ready', JSON.stringify(first.warnings))
assert.equal(first.coverage.complete, true)
assert.deepEqual(first.coverage.missing_datasets, [])
assert.deepEqual(first.coverage.missing_definitions, [])
assert.equal(first.coverage.required_datasets.length, 2)
assert.equal(first.coverage.required_definitions.length, 3)
assert.ok(first.snapshot.datasets.order_data.rows > 0)
assert.ok(first.snapshot.datasets.order_data.sha256)
assert.equal(first.snapshot.datasets.order_data.read_only, true)
assert.equal(first.snapshot.datasets.config_attribute.read_only, true)
for (const entry of Object.values(first.snapshot.definitions)) assert.equal(entry.read_only, true)
const mode = (await stat(join(first.directory, 'order_data.parquet'))).mode & 0o777
assert.equal(mode, 0o444)
const manifest = JSON.parse(await readFile(join(first.directory, 'snapshot.json'), 'utf8'))
assert.equal(manifest.version, first.snapshot_id)
console.log(`snapshot=${first.snapshot_id} reused=${first.reused} oldest=${first.freshness.oldest_age_hours}h`)

console.log('--- prepare again (expect reuse) ---')
const second = await tool.execute({ action: 'prepare', profile: 'order_config_ratio' }, execution)
assert.equal(second.reused, true)
assert.equal(second.snapshot_id, first.snapshot_id)

console.log('--- verify ---')
const verified = await tool.execute({ action: 'verify', snapshot_id: first.snapshot_id }, execution)
assert.equal(verified.status, 'verified', JSON.stringify(verified.mismatches))

console.log('--- service.ensure ---')
const ensured = await service.ensure('probe_profile', { definitionRoot: BUSINESS })
assert.equal(ensured.status, 'ready')
assert.equal(ensured.snapshot.coverage.complete, true)
assert.equal(ensured.next.tool, 'probe_analysis')

console.log('--- query.py reads the snapshot ---')
const python = existsSync(join(BUSINESS, '.venv/bin/python')) ? join(BUSINESS, '.venv/bin/python') : 'python3'
const request = {
  vehicle: 'LS8 NEO',
  metric: 'locked_orders',
  dimension: 'seat_count',
  snapshot_dir: first.directory,
  cwd: BUSINESS,
  definition_root: BUSINESS,
  business_root: BUSINESS,
  state_dir: STATE,
  python,
}
const { stdout } = await exec(python, [QUERY, '--request', JSON.stringify(request)], { cwd: BUSINESS, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
const query = JSON.parse(stdout)
assert.equal(query.status, 'ok')
assert.equal(query.data.snapshot.version, first.snapshot_id, 'query must report the data-prep snapshot id')
assert.equal(query.data.snapshot.mode, 'explicit_snapshot')
console.log(`query=${query.result.markdown.split('\n')[0]}`)

console.log('--- explicit stale-safe pinning ---')
const pinned = await tool.execute({ action: 'prepare', profile: 'order_config_ratio', snapshot_id: first.snapshot_id }, execution)
assert.equal(pinned.snapshot_id, first.snapshot_id)
assert.equal(pinned.reused, true)

dispose()
console.log('OK')
