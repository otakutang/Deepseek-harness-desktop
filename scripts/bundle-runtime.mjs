#!/usr/bin/env node
/**
 * Bundle a self-contained dsh runtime tree into resources/dsh-runtime.
 *
 * Layout: the dsh CLI package files at the root (lib/, config/, package.json)
 * plus a FLAT node_modules holding every package of the app's dependency
 * closure (dependencies + peerDependencies, BFS from the app manifest — the
 * same algorithm the runtime's own profile healing uses). Each package is
 * copied from its REAL directory in the local checkout (pnpm links are
 * dereferenced), so the tree needs no pnpm/registry at all: Node's
 * parent-directory walk from lib/bin.js lands on the flat node_modules, and
 * every bare import resolves.
 *
 * The closure transitively carries the web frontend dist
 * (@deepseek-ai/dsh-web-frontend ships dist/), every bundle (dsh-web-app),
 * all host/client plugins, and the loader's native addon
 * (node-addon-require-builtin), so a fresh `dsh web` boot self-heals its
 * profile exactly like a real installation.
 *
 * A portable Node runtime (win-x64) is downloaded into node/ — the dsh child
 * must run under a REAL Node, never Electron's embedded one: the vendored
 * loader's internal-import machinery needs the node-addon-require-builtin
 * addon, which refuses Electron's node ("Unsupported/no-realm").
 *
 * Run from desktop/: `npm run bundle:runtime` (requires the repo checkout at
 * ../ with `pnpm install` + `pnpm run build` completed there, and network
 * access to the Node mirror). Environment overrides:
 *   DSH_REPO         path to the official deepseek-harness checkout (default:
 *                    a sibling deepseek-harness-master/, deepseek-harness/,
 *                    or the parent directory)
 *   DSH_NODE_MIRROR  Node dist mirror (default npmmirror; nodejs.org works too)
 *   DSH_NODE_VERSION exact version to pin, e.g. 'v22.22.3' (default: newest
 *                    v22.x on the mirror, matching the repo's ^22.19 engine)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const out = resolve(desktop, 'resources', 'dsh-runtime')
const nodeOut = join(out, 'node')
const modulesOut = join(out, 'node_modules')

/** Locate the official deepseek-harness checkout (DSH_REPO override wins). */
function resolveOfficialRepo() {
  if (process.env.DSH_REPO) return resolve(process.env.DSH_REPO)
  const candidates = [
    resolve(desktop, '..', 'deepseek-harness-master'),
    resolve(desktop, '..', 'deepseek-harness'),
    resolve(desktop, '..'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'pnpm-workspace.yaml'))) return candidate
  }
  return candidates[0]
}
const repo = resolveOfficialRepo()
const appAnchor = join(repo, 'apps', 'cli', 'package.json')

if (!existsSync(resolve(repo, 'pnpm-workspace.yaml'))) {
  console.error(`bundle-runtime: expected the repo checkout at ${repo} (script lives at desktop/scripts/).`)
  process.exit(1)
}
if (!existsSync(appAnchor)) {
  console.error(`bundle-runtime: missing apps/cli/package.json in ${repo}; run from the repo checkout.`)
  process.exit(1)
}

/** Copy one resolved package dir into the flat runtime node_modules. */
function copyPackage(name, dir) {
  const target = join(modulesOut, ...name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(dir, target, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (src === dir) return true
      // Exclude only paths NESTED inside the package root: pnpm's .pnpm
      // layout puts "node_modules" in the real package path itself.
      const rel = src.slice(dir.length + 1).split(sep)
      return !rel.includes('node_modules') && !rel.includes('tests') && !rel.includes('coverage')
        && !src.endsWith('.map') && !src.endsWith('.tsbuildinfo')
    },
  })
}

/**
 * Build the flat closure: BFS over dependencies + peerDependencies from the
 * app manifest, resolving each package's real directory through the checkout
 * (createRequire from the anchor, like the runtime's own profile healing).
 * @param onSkipped - receives names that could not be resolved (declared but
 *                    not installed — platform-incompatible optional deps).
 */
/**
 * Resolve a dependency's real package directory by walking node_modules
 * upward from `fromDir` (Node's own algorithm, minus exports-map handling —
 * some packages do not export `./package.json`). pnpm per-package links plus
 * hoisted root links are both found this way.
 * @returns the real package directory, or undefined when unresolvable.
 */
function resolvePackageDir(fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Build the flat closure: BFS over dependencies + peerDependencies from the
 * app manifest, resolving each package's real directory through the checkout
 * (per-manifest node_modules walk, like the runtime's own profile healing).
 * @param onSkipped - receives names that could not be resolved (declared but
 *                    not installed — platform-incompatible optional deps).
 */
function buildClosure(onSkipped) {
  const links = new Map()
  const queue = [{ anchor: appAnchor, manifest: JSON.parse(readFileSync(appAnchor, 'utf8')) }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dep of [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.optionalDependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]) {
      if (links.has(dep)) continue
      const dir = resolvePackageDir(dirname(next.anchor), dep)
      if (dir === undefined) {
        onSkipped(dep)
        continue
      }
      const manifestPath = join(dir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      // Platform-incompatible packages (e.g. Linux-only sandbox addons) would
      // only bloat the tree; skip them like an install would.
      if (manifest.os && !manifest.os.includes(process.platform)) {
        onSkipped(dep)
        continue
      }
      if (manifest.cpu && !manifest.cpu.includes(process.arch)) {
        onSkipped(dep)
        continue
      }
      links.set(dep, dir)
      queue.push({ anchor: manifestPath, manifest })
    }
  }
  return links
}

/** Pick the newest v22.x release from a Node dist index (newest-first array). */
async function latestV22(mirror) {
  const response = await fetch(`${mirror}/index.json`)
  if (!response.ok) throw new Error(`bundle-runtime: failed to fetch ${mirror}/index.json (${response.status})`)
  const index = await response.json()
  const entry = index.find((item) => /^v22\.\d+\.\d+$/.test(item.version))
  if (!entry) throw new Error('bundle-runtime: no v22.x release found in the Node dist index')
  return entry.version
}

/**
 * Download and unpack a portable Node win-x64 into nodeOut. The archive's
 * inner `node-v<ver>-win-x64/` directory is flattened: nodeOut/node.exe etc.
 */
async function bundleNode() {
  const mirror = (process.env.DSH_NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node').replace(/\/$/, '')
  const version = process.env.DSH_NODE_VERSION ?? await latestV22(mirror)
  const url = `${mirror}/${version}/node-${version}-win-x64.zip`
  console.log(`bundle-runtime: downloading Node ${version} from ${mirror}`)
  const tmpZip = join(out, `node-${version}-win-x64.zip`)
  const tmpDir = join(out, 'node-unpack')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`bundle-runtime: failed to download ${url} (${response.status})`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(tmpZip, Buffer.from(await response.arrayBuffer()))
  console.log('bundle-runtime: extracting (tar -xf)')
  execFileSync('tar', ['-xf', tmpZip, '-C', tmpDir], { stdio: 'inherit' })
  rmSync(tmpZip, { force: true })
  const inner = readdirSync(tmpDir, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith('node-v'))
  if (!inner) throw new Error('bundle-runtime: unexpected archive layout — no node-v* directory found')
  rmSync(nodeOut, { recursive: true, force: true })
  renameSync(join(tmpDir, inner.name), nodeOut)
  rmSync(tmpDir, { recursive: true, force: true })
  if (!existsSync(join(nodeOut, 'node.exe'))) throw new Error('bundle-runtime: node.exe missing after extraction')
  const versionOut = execFileSync(join(nodeOut, 'node.exe'), ['--version'], { encoding: 'utf8' }).trim()
  console.log(`bundle-runtime: portable Node ready at ${nodeOut} (${versionOut})`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(modulesOut, { recursive: true })

// 1. dsh CLI package files at the runtime root.
const cliDir = join(repo, 'apps', 'cli')
for (const rel of ['lib', 'config', 'package.json', 'README.md', 'README.zh.md']) {
  const src = join(cliDir, rel)
  if (existsSync(src)) cpSync(src, join(out, rel), { recursive: true })
}

// 2. The flat dependency closure.
const skipped = []
const closure = buildClosure((name) => skipped.push(name))
for (const [name, dir] of closure) copyPackage(name, dir)
console.log(`bundle-runtime: closure copied: ${closure.size} packages (${skipped.length} skipped: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', …' : ''})`)

// 3. The portable Node runtime.
await bundleNode()
console.log('bundle-runtime: done')
