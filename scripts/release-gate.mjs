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
 * Compare two `x.y.z` numerically, ignoring a `-prerelease` suffix.
 *
 * Ignoring the suffix is deliberate: a `-rc` and the release it previews then compare equal, so
 * the gate asks for a fresh number rather than letting one version's assets be swapped twice.
 */
export function compareVersions(a, b) {
  const nums = (v) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const left = nums(a)
  const right = nums(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
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
