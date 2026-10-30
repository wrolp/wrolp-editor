// What a release has to satisfy before anything is built or sent.
//
// Three things have to name each other: the commit that was built, the `v<version>` tag that
// points at it, and the version inside the installer and inside `latest.json`. When any of them
// drifts, the published binary's sources no longer describe it — and that only surfaces when
// someone's update misbehaves. A version that is not ahead of what is already published drifts
// in a second way: clients compare versions, so an equal one is "already up to date", while
// `--clobber` replaces the asset they would have downloaded.
//
// A plain `npm run tauri build` stays free of all of this. The checks are on the two scripts
// that sign a build and put it in front of other people's machines.

import { spawnSync } from 'node:child_process'

function git(args, root) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** The commit a tag resolves to, following an annotated tag; "" when there is no such tag. */
export function tagCommit(tag, root) {
  return git(['rev-parse', '--quiet', '--verify', `${tag}^{commit}`], root)
}

/** Everything git does not call clean, untracked files included: the tag has to cover all of it. */
export function dirtyPaths(root) {
  return git(['status', '--porcelain', '--untracked-files=all'], root)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim())
}

/**
 * Compare two versions the way semver ranks them: numeric core, then a prerelease below the
 * release it previews, then identifier by identifier with digits compared as numbers.
 *
 * The prerelease half is what makes the `--pre` path work: `0.0.2-rc1` has the same core as
 * `0.0.2`, and without ranking them the gate would call the release "not ahead" of its own
 * candidates and refuse it.
 *
 * One semver consequence worth knowing when naming a candidate: `rc10` is a single alphanumeric
 * identifier and is compared as text, so it ranks below `rc9`. Spell it `rc.10` and the number
 * becomes its own numeric identifier, which compares as one.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const text = value.replace(/^v/, '').split('+')[0]
    const dash = text.indexOf('-')
    const core = (dash < 0 ? text : text.slice(0, dash)).split('.').map((n) => parseInt(n, 10) || 0)
    const pre = dash < 0 ? null : text.slice(dash + 1).split('.')
    return { core, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff) return diff
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1 // a prefix of the other ranks below it
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff) return diff
    } else if (xn !== yn) {
      return xn ? -1 : 1 // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * The local half of the gate: could what is on disk be described by `tag` afterwards?
 *
 * Returns `{ commit, problems }`, with `commit` the tag's own sha when it is ready — the same
 * value the GitHub release has to be pointed at, so the build, the tag and the release cannot
 * end up on three different commits.
 */
export function checkReleaseReady({ root, version, tag }) {
  const problems = []
  const dirty = dirtyPaths(root)
  if (dirty.length) {
    problems.push(
      'the working tree is not clean, and a release tag cannot point at what is not committed:\n' +
        `  ${dirty.join('\n  ')}\n` +
        '  commit or stash them first'
    )
  }
  const commit = tagCommit(tag, root)
  if (!commit) {
    problems.push(
      `no local tag ${tag} for version ${version} — create it once the bump is committed:\n` +
        `  git tag -a ${tag} -m "${version}" && git push origin ${tag}`
    )
  } else {
    const head = git(['rev-parse', 'HEAD'], root)
    if (commit !== head) {
      problems.push(
        `${tag} points at ${commit.slice(0, 7)} but HEAD is ${head.slice(0, 7)}; the installer ` +
          'would be built from a commit the tag does not describe — move the tag or build from the tagged commit'
      )
    }
  }
  return { commit, problems }
}

/** Every non-draft release tag GitHub has, versions without the leading `v`. Null when gh cannot answer. */
export function publishedVersions(repo) {
  const result = spawnSync(
    'gh',
    ['api', `repos/${repo}/releases?per_page=100`, '--jq', '[.[] | select(.draft | not) | .tag_name] | join("\\n")'],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) return null
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((name) => name.replace(/^v/, ''))
}
