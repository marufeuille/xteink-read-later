import type { PrChangedFile, PrChangedFileStatus } from '../types/index.ts'

const STATUS_BY_CODE: Readonly<Record<string, PrChangedFileStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'modified',
}

function tabbedLines(output: string): readonly (readonly string[])[] {
  return output.split('\n').flatMap((line) => {
    const trimmed = line.trimEnd()
    return trimmed.length === 0 ? [] : [trimmed.split('\t')]
  })
}

function parseCount(value: string): number | null {
  return value === '-' ? null : Number.parseInt(value, 10)
}

export function parseNameStatus(output: string): readonly PrChangedFile[] {
  return tabbedLines(output).flatMap((parts) => {
    const status = STATUS_BY_CODE[parts[0]?.[0] ?? ''] ?? 'unknown'
    if (parts.length >= 3) {
      const previousPath = parts[1] ?? ''
      const path = parts[2] ?? ''
      return path.length === 0
        ? []
        : [
            {
              path,
              status,
              additions: null,
              deletions: null,
              ...(previousPath.length === 0 ? {} : { previousPath }),
            },
          ]
    }
    const path = parts[1] ?? ''
    return path.length === 0 ? [] : [{ path, status, additions: null, deletions: null }]
  })
}

export function applyNumstat(
  files: readonly PrChangedFile[],
  numstat: string,
): readonly PrChangedFile[] {
  const stats = new Map<string, { readonly additions: number | null; readonly deletions: number | null }>()
  for (const parts of tabbedLines(numstat)) {
    const path = parts.length >= 4 ? (parts[3] ?? parts[2] ?? '') : (parts[2] ?? '')
    if (path.length === 0 || parts[0] === undefined || parts[1] === undefined) {
      continue
    }
    stats.set(path, {
      additions: parseCount(parts[0]),
      deletions: parseCount(parts[1]),
    })
  }
  return files.map((file) => {
    const hit = stats.get(file.path)
    return hit === undefined ? file : { ...file, additions: hit.additions, deletions: hit.deletions }
  })
}

export async function collectGitChangedFiles(
  baseSha: string,
  headSha: string,
  execGit: (args: readonly string[]) => Promise<string>,
): Promise<{ readonly files: readonly PrChangedFile[]; readonly diff: string }> {
  const range = `${baseSha}...${headSha}`
  const [nameStatus, numstat, diff] = await Promise.all([
    execGit(['diff', '--name-status', range]),
    execGit(['diff', '--numstat', range]),
    execGit(['diff', range]),
  ])
  return {
    files: applyNumstat(parseNameStatus(nameStatus), numstat),
    diff,
  }
}
