import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildSimulatorEpubs, type SimulatorExpect } from './build-epubs'
import { checkScreenshotFiles, type CheckedPage } from './check-bands'
import { decodeBmp, findImageBand } from './image-band'
import { repoRoot, simulatorOutDir } from './paths'

/** develop @ 2026-09-27. Image drawing is the upstream X3 simulator, not a fork. */
export const CROSSPOINT_FIRMWARE_SHA = '93e98bb78702e29868a16a13b80c40e6b36ccdff'
const FIRMWARE_REPO = 'https://github.com/crosspoint-reader/crosspoint-reader.git'

export type OpenBookPlan = {
  readonly script: string
  readonly fileBrowserShotMs: number
  readonly booksShotMs: number
  readonly openingShotMs: number
  readonly pageShotMs: number
  readonly quitMs: number
}

const NAV_STEP_MS = 2_000
const TURN_STEP_MS = 3_000
const QUIT_AFTER_SHOT_MS = 2_000

/**
 * First screenshot attempt. Scale 1 fires while a slow runner is still drawing,
 * so keep-image stays white and merge-gate skips the deploy.
 */
export const SIMULATOR_INPUT_SCALE = 2
/** Second attempt after an image page is still white. */
export const SIMULATOR_INPUT_RETRY_SCALE = 3

/**
 * Home, file browser, books/, then `turns` side-button page turns.
 * Input and screenshots use milliseconds from process start, so `scale`
 * stretches every gap when the runner is slow to draw.
 */
export function openBookPlan(turns: number, scale = 1): OpenBookPlan {
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) {
    throw new Error('openBookPlan scale must be an integer from 1 to 4')
  }
  const nav = NAV_STEP_MS * scale
  const turnGap = TURN_STEP_MS * scale
  const events = [`${nav}:ENTER`, `${nav * 2}:ENTER`, `${nav * 3}:ENTER`]
  let ms = nav * 3
  for (let turn = 0; turn < turns; turn += 1) {
    ms += turnGap
    events.push(`${ms}:DOWN`)
  }
  const pageShotMs = ms + turnGap
  const quitMs = pageShotMs + QUIT_AFTER_SHOT_MS * scale
  events.push(`${quitMs}:QUIT`)
  return {
    script: events.join(';'),
    fileBrowserShotMs: nav + 1_000 * scale,
    booksShotMs: nav * 2 + 1_000 * scale,
    openingShotMs: nav * 3 + 1_500 * scale,
    pageShotMs,
    quitMs,
  }
}

/** Image pages get one slower retry. Empty pages stay on the first schedule. */
export function inputScalesFor(expect: SimulatorExpect): readonly number[] {
  if (expect === 'image') {
    return [SIMULATOR_INPUT_SCALE, SIMULATOR_INPUT_RETRY_SCALE]
  }
  return [SIMULATOR_INPUT_SCALE]
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 200_000) {
        output = output.slice(-200_000)
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms\n${output}`))
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code ?? 'null'}\n${output}`))
        return
      }
      resolve(output)
    })
  })
}

export async function ensureFirmwareCheckout(): Promise<string> {
  const override = process.env.CROSSPOINT_FIRMWARE_DIR?.trim()
  const dest =
    override !== undefined && override.length > 0 ? override : join(repoRoot(), 'tmp', 'crosspoint-reader')
  if (!existsSync(join(dest, 'platformio.ini'))) {
    if (override !== undefined && override.length > 0) {
      throw new Error(`CROSSPOINT_FIRMWARE_DIR is not a CrossPoint checkout: ${dest}`)
    }
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    for (const args of pinnedFirmwareGitSteps(dest)) {
      const slow = args.includes('fetch') || args.includes('submodule')
      await runCommand('git', args, { timeoutMs: slow ? 300_000 : 30_000 })
    }
  }
  const sha = (await runCommand('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })).trim()
  if (sha !== CROSSPOINT_FIRMWARE_SHA) {
    throw new Error(`CrossPoint checkout ${sha} is not pinned ${CROSSPOINT_FIRMWARE_SHA}`)
  }
  return dest
}

/** Git commands that fetch {@link CROSSPOINT_FIRMWARE_SHA} and its submodules. */
export function pinnedFirmwareGitSteps(dest: string): readonly (readonly string[])[] {
  return [
    ['init', dest],
    ['-C', dest, 'remote', 'add', 'origin', FIRMWARE_REPO],
    ['-C', dest, 'fetch', '--depth', '1', 'origin', CROSSPOINT_FIRMWARE_SHA],
    ['-C', dest, 'checkout', '--detach', 'FETCH_HEAD'],
    ['-C', dest, 'submodule', 'update', '--init', '--recursive'],
  ]
}

function pioBinary(): string {
  const fromEnv = process.env.PIO?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv
  }
  const local = join(homedir(), '.local', 'bin', 'pio')
  return existsSync(local) ? local : 'pio'
}

function installNativeDecoderConfig(firmwareDir: string): void {
  const root = repoRoot()
  copyFileSync(join(root, 'simulator', 'platformio.x3-native.ini'), join(firmwareDir, 'platformio.local.ini'))
  copyFileSync(join(root, 'simulator', 'native-decoder-includes.py'), join(firmwareDir, 'simulator_native_includes.py'))
  const ini = readFileSync(join(firmwareDir, 'platformio.local.ini'), 'utf8')
  if (!ini.includes('-DCROSSPOINT_SIM_USE_NATIVE_DECODERS') || !ini.includes('-DSIMULATOR_DEVICE_X3')) {
    throw new Error('simulator_x3 config is missing native JPEGDEC')
  }
  if (!ini.includes('lib_ignore = hal, WebSockets')) {
    throw new Error('simulator_x3 config still ignores the native JPEGDEC library')
  }
}

async function buildSimulator(firmwareDir: string): Promise<string> {
  installNativeDecoderConfig(firmwareDir)
  await runCommand(pioBinary(), ['run', '-e', 'simulator_x3'], {
    cwd: firmwareDir,
    timeoutMs: 1_200_000,
  })
  const program = join(firmwareDir, '.pio', 'build', 'simulator_x3', 'program')
  if (!existsSync(program)) {
    throw new Error(`simulator_x3 program missing at ${program}`)
  }
  return program
}

async function openEpub(
  firmwareDir: string,
  program: string,
  epub: Uint8Array,
  outDir: string,
  id: string,
  turns: number,
  scale: number,
): Promise<string> {
  rmSync(join(firmwareDir, 'fs_'), { recursive: true, force: true })
  mkdirSync(join(firmwareDir, 'fs_', 'books'), { recursive: true })
  writeFileSync(join(firmwareDir, 'fs_', 'books', 'article.epub'), epub)
  mkdirSync(outDir, { recursive: true })
  const plan = openBookPlan(turns, scale)
  const page = join(outDir, `${id}.bmp`)
  const shots = [
    `${plan.fileBrowserShotMs}:${join(outDir, `${id}-file-browser.bmp`)}`,
    `${plan.booksShotMs}:${join(outDir, `${id}-books.bmp`)}`,
    `${plan.openingShotMs}:${join(outDir, `${id}-opening.bmp`)}`,
    `${plan.pageShotMs}:${page}`,
  ]
  const screenshots = shots.join(';')
  const display = process.env.DISPLAY
  const headless = display === undefined || display.length === 0
  const command = headless ? 'xvfb-run' : program
  const args = headless ? ['-a', program] : []
  const env = {
    ...process.env,
    CROSSPOINT_SIM_INPUT_SCRIPT: plan.script,
    CROSSPOINT_SIM_SCREENSHOTS: screenshots,
  }
  const log = await runCommand(command, args, { cwd: firmwareDir, env, timeoutMs: plan.quitMs + 15_000 })
  writeFileSync(join(outDir, `${id}.log`), log)
  if (!existsSync(page)) {
    throw new Error(`${id}: screenshot was not written\n${log}`)
  }
  return page
}

function pageStillWhite(path: string): boolean {
  return findImageBand(decodeBmp(new Uint8Array(readFileSync(path)))) === null
}

function simulatorLogTail(outDir: string, id: string): string {
  const logPath = join(outDir, `${id}.log`)
  if (!existsSync(logPath)) {
    return ''
  }
  const log = readFileSync(logPath, 'utf8').trim()
  if (log.length === 0) {
    return ''
  }
  return `\n${log.length > 4_000 ? log.slice(-4_000) : log}`
}

async function capturePage(
  firmwareDir: string,
  program: string,
  epub: Uint8Array,
  outDir: string,
  id: string,
  turns: number,
  expect: SimulatorExpect,
): Promise<string> {
  const scales = inputScalesFor(expect)
  let path = ''
  for (let index = 0; index < scales.length; index += 1) {
    const scale = scales[index] ?? SIMULATOR_INPUT_SCALE
    path = await openEpub(firmwareDir, program, epub, outDir, id, turns, scale)
    if (expect !== 'image' || !pageStillWhite(path)) {
      return path
    }
    const retry = scales[index + 1]
    if (retry !== undefined) {
      console.log(`${id}: image band is still white at scale ${scale}; opening again at scale ${retry}`)
    }
  }
  return path
}

export async function runSimulatorImageCheck(): Promise<readonly CheckedPage[]> {
  const built = await buildSimulatorEpubs()
  const firmwareDir = await ensureFirmwareCheckout()
  const program = await buildSimulator(firmwareDir)
  const outDir = simulatorOutDir()
  const shots: {
    readonly id: string
    readonly expect: SimulatorExpect
    readonly path: string
    readonly bandFrom?: string
  }[] = []
  for (const item of built) {
    const path = await capturePage(
      firmwareDir,
      program,
      item.epub,
      outDir,
      item.page.id,
      item.page.turns,
      item.page.expect,
    )
    shots.push({
      id: item.page.id,
      expect: item.page.expect,
      path,
      ...(item.page.bandFrom === undefined ? {} : { bandFrom: item.page.bandFrom }),
    })
  }
  let checked: readonly CheckedPage[]
  try {
    checked = checkScreenshotFiles(shots)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const id = shots.find((shot) => message.startsWith(`${shot.id}:`))?.id
    const log = id === undefined ? '' : simulatorLogTail(outDir, id)
    throw new Error(`${message}${log}`, { cause: error })
  }
  for (const page of checked) {
    const band = page.band
    const where = band === null ? 'none' : `${band.x},${band.y} ${band.width}x${band.height}`
    console.log(`${page.id} ${page.expect} ink=${page.inkRatio.toFixed(3)} band=${where}`)
  }
  return checked
}
