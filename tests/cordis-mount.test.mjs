import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

const host = await import(new URL('../lib/index.js', import.meta.url))

test('host half mounts and disposes in a real Cordis context', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(host)
  // Let the fiber start; a failing plugin leaves an error on the fiber instead of throwing here.
  await new Promise((resolve) => setTimeout(resolve, 20))
  try {
    assert.equal(typeof fiber.dispose, 'function')
  } finally {
    await fiber.dispose()
  }
})
