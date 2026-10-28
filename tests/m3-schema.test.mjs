import assert from 'node:assert/strict'
import test from 'node:test'

import { compileParameterSchema } from '../lib/host/schema.js'

test('compileParameterSchema wraps the property map in an open object root', () => {
  const schema = compileParameterSchema({
    query: { type: 'string', description: 'Substring filter.' },
    includeArchived: { type: 'boolean' },
    limit: { type: 'number' },
  })

  // Native function calling requires an object-rooted argument schema; a bare
  // property map reaches the provider as "type: null" and rejects every request.
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties), ['query', 'includeArchived', 'limit'])
  assert.equal(schema.required, undefined)
  assert.equal(schema.properties.query.type, 'string')
  assert.equal(schema.properties.query.description, 'Substring filter.')
  assert.equal(schema.properties.limit.type, 'number')
  assert.equal(schema.additionalProperties, undefined)
})

test('compileParameterSchema collects property-level requiredness', () => {
  const schema = compileParameterSchema({
    sessionId: { type: 'string', required: true, description: 'Exact id.' },
  })
  assert.deepEqual(schema.required, ['sessionId'])
  assert.equal(schema.properties.sessionId.type, 'string')
  // The author-only DSL marker must never leak into the wire schema.
  assert.equal(schema.properties.sessionId.required, undefined)
  assert.doesNotMatch(JSON.stringify(schema), /"required":true/)
})

test('compileParameterSchema compiles arrays, nested objects and enums', () => {
  const schema = compileParameterSchema({
    mode: { type: 'string', enum: ['preview', 'apply'] },
    ids: { type: 'array', items: { type: 'string' } },
    filter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', required: true },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  })

  assert.deepEqual(schema.properties.mode.enum, ['preview', 'apply'])
  assert.deepEqual(schema.properties.ids.items, { type: 'string' })
  const filter = schema.properties.filter
  assert.equal(filter.type, 'object')
  assert.equal(filter.additionalProperties, false)
  assert.deepEqual(filter.required, ['query'])
  assert.equal(filter.properties.query.type, 'string')
  assert.deepEqual(filter.properties.tags.items, { type: 'string' })
})

test('compileParameterSchema rejects DSL misuse instead of emitting a broken wire schema', () => {
  assert.throws(
    () => compileParameterSchema({ filter: { type: 'object' } }),
    /object nodes must declare additionalProperties/,
  )
  assert.throws(
    () => compileParameterSchema({ ids: { type: 'array', items: { type: 'string', required: true } } }),
    /required is only meaningful on a property/,
  )
  assert.throws(
    () => compileParameterSchema({ ids: { type: 'array', enum: ['a'] } }),
    /enum is not valid on array/,
  )
  assert.throws(
    () => compileParameterSchema({ query: { type: 'string', enum: [] } }),
    /enum must not be empty/,
  )
  assert.throws(
    () => compileParameterSchema({ query: { type: 'string', items: { type: 'string' } } }),
    /items is not valid on string/,
  )
})
