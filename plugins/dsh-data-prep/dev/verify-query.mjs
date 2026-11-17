/**
 * Two-plugin integration check: mount dsh-data-prep and dsh-order-config-ratio
 * on a minimal Context, then run the real order_config_ratio query. It asserts
 * that the query declares its needs, consumes the prepared snapshot, and reports
 * the same snapshot id the data-preparation plugin returned.
 *
 *   node dev/verify-query.mjs [--state <dir>]
 */
import { mashangConfig } from './mashang-config.mjs'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply as applyDataPrep } from '../index.js'

const QUERY_MODULE = process.env.DSH_DATA_PREP_QUERY_MODULE?.trim()
  || new URL('../../order-config-ratio/index.js', import.meta.url).pathname
const BUSINESS = process.env.DSH_SUPERAGENT_BUSINESS_ROOT?.trim()
  || join(process.env.HOME ?? '', 'Documents/github/mashang-service')
const args = process.argv.slice(2)
const stateIndex = args.indexOf('--state')
const STATE = stateIndex >= 0 ? resolve(args[stateIndex + 1]) : await mkdtemp(join(tmpdir(), 'dsh-data-prep-query-'))

assert.ok(existsSync(join(BUSINESS, 'dataset/order_data.parquet')), `business dataset missing under ${BUSINESS}`)
assert.ok(existsSync(QUERY_MODULE), `query plugin missing at ${QUERY_MODULE}`)

const services = new Map()
const tools = new Map()
const logger = { info: () => {}, warn: () => {}, error: () => {} }
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
  inject: (deps, callback) => {
    const present = deps.every((name) => services.has(name))
    if (!present) return
    const child = {
      get: (name) => services.get(name),
      effect: (factory) => {
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    }
    callback(child)
  },
  workingDirectory: { ensure: async () => BUSINESS },
  logger,
}

applyDataPrep(ctx, mashangConfig(BUSINESS, STATE))
const dataPreparation = services.get('dataPreparation')
assert.ok(dataPreparation, 'dataPreparation service missing')

const query = await import(QUERY_MODULE)
query.apply(ctx, { repoRoot: BUSINESS, stateDir: STATE, maxAgeHours: 24 })
const queryTool = tools.get('order_config_ratio')
assert.ok(queryTool, 'order_config_ratio tool was not registered')

const declared = dataPreparation.requirements().find((profile) => profile.name === 'order_config_ratio')
assert.equal(declared?.source, 'declared', 'the query plugin must declare its requirements')

const execution = { agent: {}, signal: new AbortController().signal }
console.log(`state: ${STATE}`)
const first = await queryTool.execute({ vehicle: 'LS8 NEO', dimension: 'seat_count' }, execution)
assert.equal(first.status, 'ok')
assert.ok(first.data_prep?.snapshot_id, 'the query must report its prepared snapshot')
assert.equal(first.data_prep.snapshot_id, first.data.snapshot.version)
assert.equal(first.data.snapshot.mode, 'explicit_snapshot')
console.log(`query snapshot=${first.data_prep.snapshot_id} reused=${first.data_prep.reused}`)
console.log(`result=${first.result.markdown.split('\n')[0]}`)

const second = await queryTool.execute({ vehicle: 'LS8 NEO', dimension: 'seat_count' }, execution)
assert.equal(second.data_prep.snapshot_id, first.data_prep.snapshot_id)
assert.equal(second.data_prep.reused, true)
console.log('OK')
