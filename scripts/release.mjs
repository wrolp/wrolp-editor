// Build the NSIS installer and report where it landed.
//
// The installer's file name carries the version, so a drift between tauri.conf.json,
// package.json and Cargo.toml is caught before the build rather than shipped as a mislabelled
// release: bump all three by hand, then run this.
//
// Usage:
//   npm run release            (or: node scripts/release.mjs)

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const { productName, version } = conf
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

const drift = [
  ['package.json', pkg.version],
  ['src-tauri/Cargo.toml', cargoVersion],
].filter(([, found]) => found !== version)
if (drift.length) {
  for (const [file, found] of drift) {
    console.error(`[release] ${file} says ${found}, tauri.conf.json says ${version}`)
  }
  console.error('[release] Bump every version before building; refusing to label a build wrongly.')
  process.exit(1)
}

// `npx` is a `.cmd` shim on Windows, which needs a shell — and Node's DEP0190 forbids an
// args array together with `shell: true`, because the arguments would be joined into one
// unescaped string. Running the CLI's own entry with this same `node` keeps every argument
// separate, including paths with spaces.
const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

console.log(`[release] building ${productName} ${version} ...`)
const res = spawnSync(process.execPath, [tauriCli, 'build'], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
})
if (res.status !== 0) process.exit(res.status ?? 1)

const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const installer = join(nsisDir, `${productName}_${version}_x64-setup.exe`)
if (!existsSync(installer)) {
  const seen = existsSync(nsisDir)
    ? readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
    : []
  console.error(`[release] expected installer not found: ${installer}`)
  if (seen.length) console.error(`[release] found instead:\n  ${seen.join('\n  ')}`)
  process.exit(1)
}

const megabytes = (statSync(installer).size / 1024 / 1024).toFixed(1)
console.log(`[release] installer: ${installer} (${megabytes} MB)`)
console.log('[release] next: npm run upload   (or npm run publish for both)')
