#!/usr/bin/env node
/**
 * Prepare a release for upload to the update feed.
 *
 * Copies the freshly built installer plus its update metadata (latest.yml,
 * blockmap) from release/ into update-staging/, ready to be uploaded to the
 * URL configured at build time (DSH_UPDATE_URL). electron-updater only needs
 * latest.yml + the installer to perform automatic updates.
 *
 * Usage (after a successful `npm run dist`):
 *   node scripts/publish-update.mjs
 * then upload update-staging/* to your update server, replacing the previous
 * contents.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const release = join(desktop, 'release')
const staging = join(desktop, 'update-staging')

if (!existsSync(release)) {
  console.error('publish-update: release/ not found — run `npm run dist` first.')
  process.exit(1)
}

/** Files electron-updater consults: metadata + installers (blockmaps optional). */
const KEEP = /(latest(-mac|-linux)?\.ya?ml|\.exe|\.blockmap)$/i

const files = readdirSync(release)
  .filter((name) => KEEP.test(name))
  .filter((name) => !name.endsWith('.blockmap') || name.includes('.exe')) // only the exe's blockmap

if (files.length === 0) {
  console.error('publish-update: no installer/metadata found in release/.')
  process.exit(1)
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
for (const name of files) {
  copyFileSync(join(release, name), join(staging, name))
  console.log(`  ${name}`)
}
console.log(`\npublish-update: ${files.length} file(s) staged in update-staging/`)
console.log('Upload the WHOLE staging directory to the update feed URL, replacing old files.')
