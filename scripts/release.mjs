// Build the NSIS installer, sign it for the updater, and write latest.json beside it.
//
// The installer's file name carries the version, so a drift between tauri.conf.json,
// package.json and Cargo.toml is caught before the build rather than shipped as a mislabelled
// release: bump all three by hand, then run this.
//
// The build is also gated on the release being describable afterwards — a clean working tree and
// a local `v<version>` tag on HEAD, which is what `scripts/release-gate.mjs` checks and why.
// Building without signing stays free of that: `npm run tauri build`.
//
// The signing key lives at `.tauri/priv.key` (untracked) and its public half is in
// tauri.conf.json. Without the private half no `.sig` is produced, so the build could not be
// served to existing installs — the script refuses rather than leaving a release that silently
// cannot update anyone.
//
// tauri.conf.json keeps `createUpdaterArtifacts` false so that a plain `yarn tauri build` neither
// signs nor asks for the key passphrase; this script is the only place that turns it on.
//
// Usage:
//   npm run release            (or: node scripts/release.mjs)

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseReady } from './release-gate.mjs'

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

// The tag is decided here rather than at upload time so that both halves of `npm run publish`
// gate on the same one, and the release points at the commit this build came from.
const tag = `v${version}`
const ready = checkReleaseReady({ root, version, tag })
if (ready.problems.length) {
  for (const problem of ready.problems) console.error(`[release] ${problem}`)
  console.error('[release] refusing to build a release nothing could point at.')
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

// A release is the one build that must not carry anything from an earlier one. `target/` is
// reused by cargo, and resources the build script does not watch — the icon set, tauri.conf.json —
// can otherwise stay stale inside the exe; `dist/` is the same idea for the frontend bundle.
// Costly on purpose: this is the step that makes "rebuilt and it is still the old icon" impossible.
console.log('[release] cleaning previous build output ...')
const clean = spawnSync('cargo', ['clean'], {
  stdio: 'inherit',
  cwd: join(root, 'src-tauri'),
})
if (clean.status !== 0) {
  console.error('[release] cargo clean failed; refusing to build on top of old artefacts.')
  process.exit(clean.status ?? 1)
}
rmSync(join(root, 'dist'), { recursive: true, force: true })

// `npx` is a `.cmd` shim on Windows, which needs a shell — and Node's DEP0190 forbids an
// args array together with `shell: true`, because the arguments would be joined into one
// unescaped string. Running the CLI's own entry with this same `node` keeps every argument
// separate, including paths with spaces.
const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

console.log(`[release] building and signing ${productName} ${version} ...`)
const res = spawnSync(process.execPath, [
  tauriCli,
  'build',
  '--config',
  JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
], {
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

// The `--config` override above is what makes the CLI sign, and only for this script. Signing is
// skipped silently, and an unsigned build leaves the previous release's `.sig` sitting in the same
// folder — so the file has to be at least as new as the installer to count as this build's.
const signature = installer + '.sig'
if (!existsSync(signature) || statSync(signature).mtimeMs < statSync(installer).mtimeMs) {
  console.error(`[release] no updater signature from this build: ${signature}`)
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
