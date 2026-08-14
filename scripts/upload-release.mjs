#!/usr/bin/env node
/**
 * Upload the built installer + update metadata to a GitHub Release.
 *
 * Requires a GitHub token with repo write access, provided via env:
 *   GH_TOKEN=<token> node scripts/upload-release.mjs [tag]
 *
 * Uploads release/latest.yml, release/*.exe.blockmap, and release/*.exe to
 * the release for `tag` (defaults to `v<package.json version>`), creating the
 * release if it does not exist. Run this from a network that can reach
 * uploads.github.com (large transfers may be interrupted on some networks;
 * retry or use a proxy in that case).
 */
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'release')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const OWNER = 'otakutang'
const REPO = 'Deepseek-harness-desktop'
const token = process.env.GH_TOKEN
const tag = process.argv[2] ?? `v${pkg.version}`

if (!token) {
  console.error('upload-release: set GH_TOKEN to a GitHub token with repo scope.')
  process.exit(1)
}

const api = `https://api.github.com/repos/${OWNER}/${REPO}`
const auth = { Authorization: `token ${token}`, 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' }

async function findOrCreateRelease() {
  const list = await fetch(`${api}/releases`, { headers: auth }).then((r) => r.json())
  const existing = Array.isArray(list) ? list.find((release) => release.tag_name === tag) : undefined
  if (existing) return existing
  const body = JSON.stringify({ tag_name: tag, name: tag, body: `DeepSeek Harness Desktop ${tag}` })
  const response = await fetch(`${api}/releases`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body })
  if (!response.ok) throw new Error(`create release failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function upload(uploadUrl, filePath) {
  const name = filePath.split(/[/\\]/).pop()
  const size = statSync(filePath).size
  const target = `${uploadUrl.replace(/\{\?.*\}$/, '')}?name=${encodeURIComponent(name)}`
  console.log(`uploading ${name} (${Math.round(size / 1024 / 1024)} MB) ...`)
  const body = Readable.toWeb(createReadStream(filePath))
  const response = await fetch(target, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/octet-stream' },
    body,
    duplex: 'half',
  })
  if (!response.ok) throw new Error(`upload ${name} failed: ${response.status} ${await response.text()}`)
  const asset = await response.json()
  console.log(`  ok: ${asset.name}`)
}

const release = await findOrCreateRelease()
console.log(`release: ${release.tag_name} (id ${release.id})`)
for (const name of readdirSync(releaseDir)) {
  if (name === 'latest.yml' || name.endsWith('.exe.blockmap') || name.endsWith('.exe')) {
    await upload(release.upload_url, join(releaseDir, name))
  }
}
console.log('upload-release: done')
