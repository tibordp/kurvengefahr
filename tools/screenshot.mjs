#!/usr/bin/env node
// Render a .kgz document to a PNG through the real app in headless Chrome, via the public
// `window.kurvengefahr` API: import the container, wait for worker-backed generation (handwriting,
// raster) to settle, fit the view, screenshot. Regenerates the README screenshots in docs/.
//
//   node tools/screenshot.mjs <doc.kgz> [out.png]
//
// Options:
//   --url <u>      app URL (default http://localhost:5173; a vite dev server is spawned on a
//                  spare port when nothing answers there)
//   --width <px>   viewport width  (default 1440)
//   --height <px>  viewport height (default 900)
//   --scale <n>    deviceScaleFactor (default 2)
//   --theme <t>    light | dark (default light)
//
// [out.png] defaults to docs/<doc basename>.png. Mac-only: uses the installed Google Chrome
// (override with CHROME_PATH).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(toolsDir)
const docsDir = path.join(repoRoot, 'docs')

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SPAWN_PORT = 5199

// ---- arguments ----------------------------------------------------------------------------------

// Usage errors happen before any resources exist, so exiting directly here is safe.
function usageFail(msg) {
  console.error(`screenshot: ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const opts = { url: 'http://localhost:5173', width: 1440, height: 900, scale: 2, theme: 'light' }
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    if (!(key in opts)) usageFail(`unknown option ${a}`)
    const v = args[++i]
    opts[key] = typeof opts[key] === 'number' ? Number(v) : v
  } else positional.push(a)
}
const [kgzArg, outArg] = positional
if (!kgzArg) usageFail('usage: node docs/screenshot.mjs <doc.kgz> [out.png] [--url|--width|--height|--scale|--theme]')
if (opts.theme !== 'light' && opts.theme !== 'dark') usageFail(`--theme must be light or dark, got "${opts.theme}"`)
const kgzPath = path.resolve(kgzArg)
const outPath = path.resolve(outArg ?? path.join(docsDir, path.basename(kgzPath).replace(/\.kgz$/i, '') + '.png'))
const kgz = readFileSync(kgzPath)

function fail(msg) {
  throw new Error(msg)
}

// ---- app server ---------------------------------------------------------------------------------

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** Use the URL if something answers there, else spawn `npm run dev` on SPAWN_PORT (predev builds
 *  the wasm, so this works from a clean checkout — first boot can take a minute). */
async function ensureServer() {
  if (await isUp(opts.url)) return { url: opts.url, child: null }
  const url = `http://localhost:${SPAWN_PORT}`
  console.log(`no app at ${opts.url} — starting a dev server at ${url}`)
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(SPAWN_PORT), '--strictPort', '--clearScreen', 'false'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true, // own process group, so we can kill vite together with the npm wrapper
  })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await isUp(url)) return { url, child }
    if (child.exitCode !== null) fail(`dev server exited with code ${child.exitCode}`)
    await sleep(500)
  }
  fail('dev server did not come up within 180 s')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- drive the app ------------------------------------------------------------------------------

let child = null
let browser
try {
  const server = await ensureServer()
  child = server.child
  const url = server.url
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: opts.scale })
  // Set the theme before the app boots (the no-flash script in index.html reads it pre-paint).
  await page.evaluateOnNewDocument((theme) => localStorage.setItem('kg-theme', theme), opts.theme)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.kurvengefahr, { timeout: 60_000 })

  const res = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return window.kurvengefahr.importDocument(bytes)
  }, kgz.toString('base64'))
  if (res.status !== 'ok') fail(`import failed (${res.status}): ${res.message}`)

  // Wait for worker-backed generation to settle: busy must stay false across a few polls (the
  // generation controller only picks up new elements on the next document tick, and the first
  // handwriting run also fetches the ~7 MB model).
  let settled = 0
  const deadline = Date.now() + 300_000
  while (settled < 4) {
    if (Date.now() > deadline) fail('generation did not settle within 300 s')
    const gen = await page.evaluate(() => window.kurvengefahr.generationStatus())
    if (gen.errors.length) fail(`generation failed:\n  ${gen.errors.join('\n  ')}`)
    settled = gen.busy ? 0 : settled + 1
    await sleep(250)
  }

  await page.evaluate(() => window.kurvengefahr.fitView())
  await page.evaluate(() => document.fonts.ready)
  await sleep(500) // let Konva paint the fitted frame
  await page.screenshot({ path: outPath })
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${opts.width}x${opts.height} @${opts.scale}x, ${opts.theme})`)
} catch (e) {
  console.error(`screenshot: ${e?.message ?? e}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (child?.pid) process.kill(-child.pid, 'SIGTERM')
}
