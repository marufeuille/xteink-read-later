import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const simulatorDir = dirname(fileURLToPath(import.meta.url))

export function repoRoot(): string {
  return join(simulatorDir, '..')
}

export function simulatorInputsDir(): string {
  return join(simulatorDir, 'inputs')
}

export function simulatorOutDir(): string {
  return join(simulatorDir, 'out')
}
