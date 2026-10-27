#!/usr/bin/env node
/** Remove build output so a clean build can be verified. */

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await rm(path.join(root, 'lib'), { recursive: true, force: true })
console.log('clean: removed lib/')
