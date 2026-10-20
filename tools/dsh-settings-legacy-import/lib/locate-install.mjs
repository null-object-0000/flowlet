/**
 * Locate an installed `@deepseek-ai/dsh-settings` package.
 *
 * Shared by the installer and the regression tests so both agree on which
 * installation is under test.
 *
 * @module tools/dsh-settings-legacy-import/lib/locate-install
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Candidate package directories, best first. */
export function candidates(explicit) {
  const list = []
  if (explicit !== undefined && explicit !== null && String(explicit).length > 0) {
    const base = resolve(String(explicit))
    list.push(
      base,
      join(base, 'node_modules', '@deepseek-ai', 'dsh-settings'),
      join(base, '@deepseek-ai', 'dsh-settings'),
    )
  }
  // The global installation that owns the running node binary.
  const globalLib = resolve(process.execPath, '..', '..', 'lib', 'node_modules')
  list.push(join(globalLib, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-settings'))
  list.push(join(globalLib, '@deepseek-ai', 'dsh-settings'))
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (root.length > 0) {
      list.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-settings'))
      list.push(join(root, '@deepseek-ai', 'dsh-settings'))
    }
  } catch {
    /* npm may be absent; the other candidates still apply */
  }
  list.push(join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-settings'))
  return list
}

/**
 * Resolve the installed `dsh-settings` package directory.
 * @param explicit Optional `--root`-style hint.
 * @returns The absolute package directory.
 * @throws When no candidate holds `@deepseek-ai/dsh-settings`.
 */
export function locateDshSettings(explicit) {
  for (const candidate of candidates(explicit ?? process.env.DSH_SETTINGS_DIR)) {
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh-settings') return candidate
    } catch {
      /* not the package we want */
    }
  }
  throw new Error(
    'could not locate @deepseek-ai/dsh-settings; pass --root <dir> or set DSH_SETTINGS_DIR',
  )
}

/**
 * Resolve the installed `@deepseek-ai/dsh` package directory.
 * @param settingsRoot A located `dsh-settings` directory, when already known.
 * @returns The absolute package directory.
 */
export function locateDsh(settingsRoot) {
  const roots = []
  if (settingsRoot !== undefined) roots.push(resolve(settingsRoot, '..', '..', '..'))
  const globalLib = resolve(process.execPath, '..', '..', 'lib', 'node_modules')
  roots.push(join(globalLib, '@deepseek-ai', 'dsh'))
  for (const candidate of roots) {
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return candidate
    } catch {
      /* keep looking */
    }
  }
  throw new Error('could not locate @deepseek-ai/dsh; set DSH_INSTALL_DIR')
}
