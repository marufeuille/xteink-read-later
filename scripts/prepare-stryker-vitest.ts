import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Vitest 5 matches testNamePattern against fullTestName, joined with " > ".
// @stryker-mutator/vitest-runner 10.0.0 joins suite names with a space, so the
// filtered mutant run skips every test and reports them as survived.
const SPACE_JOIN = "return nameParts.join(' ').trim();"
const VITEST_JOIN = "return nameParts.join(' > ').trim();"

const FILES = [
  'node_modules/@stryker-mutator/vitest-runner/dist/src/test-helpers.js',
  'node_modules/@stryker-mutator/vitest-runner/dist/src/stryker-setup.js',
]

export function patchStrykerTestNameJoin(source: string, filePath: string): string {
  if (source.includes(VITEST_JOIN)) return source
  if (!source.includes(SPACE_JOIN)) {
    throw new Error(`${filePath} does not contain the Stryker test-name join this repo patches`)
  }
  return source.replaceAll(SPACE_JOIN, VITEST_JOIN)
}

export function patchStrykerVitestRunner(root: string): void {
  for (const relativePath of FILES) {
    const filePath = join(root, relativePath)
    const source = readFileSync(filePath, 'utf8')
    const patched = patchStrykerTestNameJoin(source, relativePath)
    if (patched !== source) writeFileSync(filePath, patched)
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  patchStrykerVitestRunner(join(dirname(fileURLToPath(import.meta.url)), '..'))
}
