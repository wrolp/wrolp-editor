// Build the NSIS installer, sign it for the updater, and write latest.json beside it.
//
// The installer's file name carries the version, so a drift between tauri.conf.json,
// package.json and Cargo.toml is caught before the build rather than shipped as a mislabelled
// release: bump all three by hand, then run this.
//
// The signing key lives at `.tauri/priv.key` (untracked) and its public half is in
// tauri.conf.json. Without the private half no `.sig` is produced, so the build could not be
// served to existing installs — the script refuses rather than leaving a release that silently
// cannot update anyone.
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

// The updater verifies every download against the public key in tauri.conf.json; the private
// half is what signs this build. It is a secret: it stays in .tauri/ (ignored by git) and must
// be backed up — losing it means existing installs can no longer accept an update.
const keyPath = join(root, '.tauri', 'priv.key')
if (!existsSync(keyPath)) {
  console.error(`[release] no signing key at ${keyPath}`)
  console.error('[release] generate one with: npx tauri signer generate -w .tauri/priv.key')
  process.exit(1)
}
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim() }
const passPath = keyPath + '.pass'
if (existsSync(passPath)) {
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(passPath, 'utf8').trim()
}

// `npx` is a `.cmd` shim on Windows, which needs a shell — and Node's DEP0190 forbids an
// args array together with `shell: true`, because the arguments would be joined into one
// unescaped string. Running the CLI's own entry with this same `node` keeps every argument
// separate, including paths with spaces.
const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

console.log(`[release] building and signing ${productName} ${version} ...`)
const res = spawnSync(process.execPath, [tauriCli, 'build'], {
  stdio: 'inherit',
  cwd: root,
  env,
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

// `createUpdaterArtifacts` makes the CLI sign the installer when the key is set. A missing
// `.sig` means the key was not picked up, and latest.json would have nothing to carry.
const signature = installer + '.sig'
if (!existsSync(signature)) {
  console.error(`[release] updater signature missing: ${signature}`)
  console.error('[release] the build was not signed; check .tauri/priv.key')
  process.exit(1)
}

const megabytes = (statSync(installer).size / 1024 / 1024).toFixed(1)
console.log(`[release] installer: ${installer} (${megabytes} MB)`)

const latest = spawnSync(process.execPath, [join(__dirname, 'gen-latest-json.mjs')], {
  stdio: 'inherit',
  cwd: root,
})
if (latest.status !== 0) process.exit(latest.status ?? 1)

console.log('[release] next: npm run upload   (or npm run publish for both)')
