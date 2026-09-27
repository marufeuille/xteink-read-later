import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildSimulatorEpubs } from './build-epubs'
import { checkScreenshotFiles, type CheckedPage } from './check-bands'
import { repoRoot, simulatorOutDir } from './paths'

/** develop @ 2026-09-27. Image drawing is the upstream X3 simulator, not a fork. */
export const CROSSPOINT_FIRMWARE_SHA = '93e98bb78702e29868a16a13b80c40e6b36ccdff'
const FIRMWARE_REPO = 'https://github.com/crosspoint-reader/crosspoint-reader.git'

export type OpenBookPlan = {
  readonly script: string
  readonly pageShotMs: number
  readonly quitMs: number
}

/** Home, file browser, books/, then `turns` side-button page turns. */
export function openBookPlan(turns: number): OpenBookPlan {
  const events = ['2000:ENTER', '4000:ENTER', '6000:ENTER']
  let ms = 6000
  for (let turn = 0; turn < turns; turn += 1) {
    ms += 3000
    events.push(`${ms}:DOWN`)
  }
  const pageShotMs = ms + 3000
  const quitMs = pageShotMs + 2000
  events.push(`${quitMs}:QUIT`)
  return { script: events.join(';'), pageShotMs, quitMs }
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
    mkdirSync(dirname(dest), { recursive: true })
    await runCommand(
      'git',
      ['clone', '--recursive', '--depth', '1', '--branch', 'develop', FIRMWARE_REPO, dest],
      { timeoutMs: 300_000 },
    )
  }
  const sha = (await runCommand('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })).trim()
  if (sha !== CROSSPOINT_FIRMWARE_SHA) {
    throw new Error(`CrossPoint checkout ${sha} is not pinned ${CROSSPOINT_FIRMWARE_SHA}`)
  }
  return dest
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
    timeoutMs: 600_000,
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
): Promise<string> {
  rmSync(join(firmwareDir, 'fs_'), { recursive: true, force: true })
  mkdirSync(join(firmwareDir, 'fs_', 'books'), { recursive: true })
  writeFileSync(join(firmwareDir, 'fs_', 'books', 'article.epub'), epub)
  mkdirSync(outDir, { recursive: true })
  const plan = openBookPlan(turns)
  const page = join(outDir, `${id}.bmp`)
  const shots = [
    `3000:${join(outDir, `${id}-file-browser.bmp`)}`,
    `5000:${join(outDir, `${id}-books.bmp`)}`,
  ]
  if (plan.pageShotMs > 8000) {
    shots.push(`7500:${join(outDir, `${id}-opening.bmp`)}`)
  }
  shots.push(`${plan.pageShotMs}:${page}`)
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

export async function runSimulatorImageCheck(): Promise<readonly CheckedPage[]> {
  const built = await buildSimulatorEpubs()
  const firmwareDir = await ensureFirmwareCheckout()
  const program = await buildSimulator(firmwareDir)
  const outDir = simulatorOutDir()
  const shots: {
    readonly id: string
    readonly expect: 'image' | 'empty'
    readonly path: string
    readonly bandFrom?: string
  }[] = []
  for (const item of built) {
    const path = await openEpub(firmwareDir, program, item.epub, outDir, item.page.id, item.page.turns)
    shots.push({
      id: item.page.id,
      expect: item.page.expect,
      path,
      ...(item.page.bandFrom === undefined ? {} : { bandFrom: item.page.bandFrom }),
    })
  }
  const checked = checkScreenshotFiles(shots)
  for (const page of checked) {
    const band = page.band
    const where = band === null ? 'none' : `${band.x},${band.y} ${band.width}x${band.height}`
    console.log(`${page.id} ${page.expect} ink=${page.inkRatio.toFixed(3)} band=${where}`)
  }
  return checked
}
