#!/usr/bin/env node
/**
 * Generate build/icon.png — the DeepSeek Harness whale logo on a dark tile.
 *
 * The whale path is an exact extract of the official FishLogo component
 * (packages/client/ui-primitives/src/FishLogo.tsx in the DeepSeek Harness
 * repo, figma I39:24057), re-rendered at 256x256 for the app icon. The logo
 * shape is (c) DeepSeek; this script only renders it as a build asset.
 *
 * Usage: node scripts/generate-icon.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const pathData = readFileSync(join(here, 'whale-path.txt'), 'utf8').trim()

const size = 256
// Center the 23.16x17.04 whale at ~180px wide (keeps the logo ratio).
const scale = 180 / 23.16
const whaleW = 23.16 * scale
const whaleH = 17.04 * scale
const x = (size - whaleW) / 2
const y = (size - whaleH) / 2

const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1115"/>
      <stop offset="1" stop-color="#1a2438"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="56" fill="url(#bg)"/>
  <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path d="${pathData}" fill="#4D6BFE"/>
  </g>
</svg>`

const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
mkdirSync(join(desktop, 'build'), { recursive: true })
const out = join(desktop, 'build', 'icon.png')
writeFileSync(out, png)
console.log(`icon written: ${out} (${png.length} bytes)`)
