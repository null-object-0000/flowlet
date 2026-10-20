/**
 * Shared fixtures for the legacy-settings migration regression suite.
 *
 * The unit tests drive the *replacement* module through a faithful fake of the
 * `SettingsForms` host surface (`ownerContext` / `update` / `documentPath`), so
 * the transaction, ordering, rollback and reporting rules can be asserted
 * without a running Cordis tree. The end-to-end test boots the real `dsh` CLI
 * against a throwaway `DSH_HOME` composed from the shipped bundles.
 *
 * @module tools/dsh-settings-legacy-import/tests/helpers
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { locateDsh, locateDshSettings } from '../lib/locate-install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TOOL_ROOT = resolve(HERE, '..')
export const REPO_ROOT = resolve(TOOL_ROOT, '..', '..')
export const SOURCE_MODULE = join(TOOL_ROOT, 'lib', 'legacy-import-fix.js')

/** Scratch space; kept inside the checkout because `/tmp` is not durable here. */
export const RUN_ROOT = join(TOOL_ROOT, '.tmp', `run-${process.pid}`)

/** The located `@deepseek-ai/dsh-settings` package directory. */
export function settingsRoot() {
  return locateDshSettings()
}

/** The located `@deepseek-ai/dsh` package directory. */
export function dshRoot() {
  return locateDsh(settingsRoot())
}

/** The YAML implementation the installed package itself uses. */
export function loadYaml() {
  return createRequire(join(settingsRoot(), 'package.json'))('yaml')
}

/** Import a file inside the installed DSH tree by absolute path. */
export function importFromDsh(relative) {
  return import(pathToFileURL(join(dshRoot(), 'node_modules', relative)).href)
}

let stagedModule

/**
 * Stage the replacement module in a directory the test controls.
 *
 * It is copied byte-for-byte, so tests exercise exactly the file the installer
 * ships; `yaml` is injected by the tests rather than resolved, which keeps the
 * suite independent of the tool's own dependency tree.
 *
 * @returns The staged module path.
 */
export async function stageFixModule() {
  if (stagedModule !== undefined) return stagedModule
  const dir = join(RUN_ROOT, 'stage', 'lib')
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'legacy-import-fix.js')
  await cp(SOURCE_MODULE, target)
  stagedModule = target
  return target
}

/** Import the staged replacement module. */
export async function loadFixModule() {
  return import(pathToFileURL(await stageFixModule()).href)
}

/**
 * Whether the *installed* package carries the transactional migration.
 *
 * The end-to-end suite exercises the real `dsh` process, so it needs the
 * override installed; the unit and schema suites do not.
 */
export async function installedFixState() {
  const root = settingsRoot()
  const indexPath = join(root, 'lib', 'index.js')
  const modulePath = join(root, 'lib', 'legacy-import-fix.js')
  const index = await readFile(indexPath, 'utf8')
  const modulePresent = existsSync(modulePath)
  return {
    root,
    version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
    patched: index.includes('dsh-legacy-import-fix ─'),
    modulePresent,
    moduleCurrent: modulePresent && (await readFile(modulePath, 'utf8')) === (await readFile(SOURCE_MODULE, 'utf8')),
  }
}

/** Remove the scratch tree this suite created. */
export async function cleanupRunRoot() {
  await rm(RUN_ROOT, { recursive: true, force: true })
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Deep-merge plain objects, replacing every other value wholesale. */
export function mergePatch(under, over) {
  if (!isPlainObject(under) || !isPlainObject(over)) return structuredClone(over)
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? mergePatch(merged[key], value) : structuredClone(value)
  }
  return merged
}

function deepEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Profile rows a stock `dsh-base` composition exposes to the config editor. */
const DEFAULT_PROFILE_ENTRIES = [
  'llm-pi-ai',
  'agent-default-model',
  'llm-deepseek',
  'ui-settings',
  'ui-settings-general',
  'bash-sandbox',
  'pwsh-sandbox',
]

/**
 * Build a fake `SettingsForms` host.
 *
 * It models everything the migration depends on: the profile paths, a profile
 * patch document of id-targeted rows over inherited bundle config, the live
 * adapter registry, and the exact misbehaviours reproduced in the field.
 *
 * @param options.home Harness home the legacy document lives in.
 * @param options.profileName `web` or `headless`.
 * @param options.profileDir Profile directory owning the patch document.
 * @param options.entries Initial profile-patch rows: entry id -> raw config.
 * @param options.inherited Inherited bundle-layer config per entry id.
 * @param options.declaredEntries Entry ids addressable by the editor.
 * @param options.configurableRoutes `llm.listConfigurableProviders()` answer.
 * @param options.registeredRoutes `llm.listProviders()` answer.
 * @param options.failOn Entry id whose patch write must throw.
 * @param options.updateThrows Make every patch write throw.
 * @param options.registrationSideEffect Whether writing `llm-pi-ai` also makes
 *   its routes appear in `llm.listProviders()`; set false to model a profile the
 *   adapter refuses to serve after the write.
 * @param options.inactive Simulate a disposed settings context (failed startup).
 * @param options.configEditorInactive Make `ownerContext.configEditor` throw.
 * @returns The fake host plus its observable state.
 */
export function makeHost(options = {}) {
  const home = options.home ?? join(RUN_ROOT, 'home')
  const profileName = options.profileName ?? 'web'
  const profileDir = options.profileDir ?? join(home, 'profiles', profileName)
  const patchPath = options.patchPath ?? join(profileDir, 'cordis.patch.yml')

  const rows = new Map(Object.entries(options.entries ?? {}))
  const inherited = new Map(Object.entries(options.inherited ?? {}))
  const entries = new Set([...DEFAULT_PROFILE_ENTRIES, ...Object.keys(options.entries ?? {}), ...(options.declaredEntries ?? [])])
  const events = []
  const logs = { info: [], warn: [], error: [] }
  const registered = new Set(options.registeredRoutes ?? ['deepseek-official', 'flowlet'])
  const configurable = new Set(options.configurableRoutes ?? ['deepseek-official', 'flowlet'])

  const entryObjects = new Map()
  const entryFor = (id) => {
    if (!entryObjects.has(id)) entryObjects.set(id, { options: { id } })
    const entry = entryObjects.get(id)
    entry.options.config = rows.has(id) ? structuredClone(rows.get(id)) : undefined
    return entry
  }

  const configEditor = {
    entries() {
      events.push({ type: 'entries' })
      return [...entries].sort().map(entryFor)
    },
    async edit(entry, change) {
      const id = entry.options.id
      if (options.updateThrows === true) throw new Error('injected failure for every entry')
      if (options.failOn === id) throw new Error(`injected failure for entry "${id}"`)
      const next = change(structuredClone(rows.get(id) ?? {}), structuredClone(inherited.get(id) ?? {}))
      events.push({ type: 'edit', id, next: structuredClone(next) })
      if (deepEqual(next, inherited.get(id) ?? {})) rows.delete(id)
      else rows.set(id, structuredClone(next))
      if (options.registrationSideEffect !== false && id === 'llm-pi-ai') {
        for (const route of Object.keys(next?.providers ?? {})) registered.add(route)
      }
    },
  }

  const llm = {
    listConfigurableProviders: () => [...configurable].map((provider) => ({ provider, settingsNs: 'llm-pi-ai' })),
    listProviders: () => [...registered].map((id) => ({ id, name: id })),
  }

  const host = {
    closed: options.inactive === true,
    ownerContext: {
      profileContext: { home, name: profileName, dir: profileDir, patchPath },
      fiber: { state: options.inactive === true ? 3 : 2 },
      logger: {
        info: (...args) => logs.info.push(args),
        warn: (...args) => logs.warn.push(args),
        error: (...args) => logs.error.push(args),
      },
      get: (name) => (name === 'llm' ? llm : undefined),
      get configEditor() {
        if (options.configEditorInactive === true) {
          throw new Error('cannot get required service "configEditor" in inactive context')
        }
        return configEditor
      },
    },
    get documentPath() {
      if (options.inactive === true) throw new Error('inactive context')
      return patchPath
    },
    async update(ns, patch) {
      if (options.updateThrows === true) throw new Error('injected failure for every entry')
      events.push({ type: 'update', id: ns, patch: structuredClone(patch) })
      if (!entries.has(ns)) throw new Error(`No configurable plugin entry "${ns}"`)
      await configEditor.edit(entryFor(ns), (current) => mergePatch(current, patch))
    },
  }

  return { host, events, logs, rows, inherited, registered, configurable, home, patchPath, profileDir, profileName }
}

/** Write `<home>/settings.yaml` from a YAML string. */
export async function writeLegacyDocument(home, yamlText) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), yamlText)
}

/** Read the failure ledger, or `undefined` when the migration never wrote one. */
export async function readFailureReport(home) {
  const path = join(home, 'settings.yaml.import-error.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Where the legacy document stands after a run. */
export async function legacyDocumentState(home) {
  const path = join(home, 'settings.yaml')
  const imported = `${path}.imported`
  return {
    present: existsSync(path),
    imported: existsSync(imported),
    text: existsSync(path) ? await readFile(path, 'utf8') : undefined,
    importedText: existsSync(imported) ? await readFile(imported, 'utf8') : undefined,
  }
}

/** The exact legacy document reported in the bug report. */
export const FLOWLET_LEGACY_YAML = `llm-pi-ai:
  providers:
    flowlet:
      api: openai-completions
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      baseURL: http://127.0.0.1:18640/v1
      displayName: Flowlet
      models:
        - id: flowlet-pro
          contextWindow: 1048576
          input: [text, image]
        - id: flowlet-flash
          contextWindow: 1048576
          input: [text, image]
agent-default-model:
  provider: flowlet
  model: flowlet-pro
`

/**
 * The same document, but with the provider endpoint unreachable and retries
 * disabled, so an end-to-end boot finishes without needing a live model server.
 */
export const FLOWLET_LEGACY_YAML_OFFLINE = `llm-pi-ai:
  providers:
    flowlet:
      api: openai-completions
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      baseURL: http://127.0.0.1:1/v1
      displayName: Flowlet
      retryPolicy:
        mode: normal
        maxRetries: 0
      models:
        - id: flowlet-pro
          contextWindow: 1048576
          input: [text, image]
        - id: flowlet-flash
          contextWindow: 1048576
          input: [text, image]
agent-default-model:
  provider: flowlet
  model: flowlet-pro
`

const PROFILE_BUNDLES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}

/**
 * Build a throwaway `DSH_HOME` holding minimal web and headless profiles
 * composed from the shipped bundles, plus a placeholder credential store.
 *
 * @param name Scratch directory name.
 * @param legacyYaml Optional `settings.yaml` contents to seed the migration with.
 * @returns The absolute harness home.
 */
export async function makeDshHome(name, legacyYaml) {
  const home = join(RUN_ROOT, name)
  await rm(home, { recursive: true, force: true })
  await mkdir(join(home, 'profiles'), { recursive: true })
  for (const [profile, bundles] of Object.entries(PROFILE_BUNDLES)) {
    const dir = join(home, 'profiles', profile)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dsh: { profile: { bundles } } }, null, 2)}\n`,
    )
    await writeFile(join(dir, 'cordis.yml'), '# fixture profile root\n[]\n')
    await writeFile(join(dir, 'cordis.patch.yml'), '# fixture patch\n[]\n')
  }
  // A stock installation resolves shipped bundles from the sibling
  // `profiles/node_modules`; borrow the real one read-only when it exists.
  const realProfiles = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '/root', '.dsh'), 'profiles')
  if (existsSync(join(realProfiles, 'node_modules'))) {
    await symlink(join(realProfiles, 'node_modules'), join(home, 'profiles', 'node_modules'))
  }
  // The managed credential store must be owner-readable only.
  await writeFile(
    join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  FLOWLET_CLIENT_TOKEN: e2e-placeholder-token\n',
    { mode: 0o600 },
  )
  if (legacyYaml !== undefined) await writeFile(join(home, 'settings.yaml'), legacyYaml)
  return home
}

/** Run the installed `dsh` CLI against a throwaway home. */
export function runDsh(home, args, { timeoutMs = 180000, env = {} } = {}) {
  const bin = join(dshRoot(), 'lib', 'bin.js')
  return new Promise((settle) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ALL_PROXY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal, stdout, stderr })
    })
  })
}

/**
 * Run the installed `dsh` CLI and kill it as soon as one of its output streams
 * matches; used for long-lived surfaces such as `--profile web`.
 *
 * The migration runs after `loader.await()` resolves, which can be a moment
 * after a surface prints its ready line, so `until` may be async and may also
 * inspect the filesystem; the child is only killed once it answers true.
 *
 * @param until Predicate over the accumulated `{ stdout, stderr }`.
 */
export function runDshUntil(home, args, { timeoutMs = 180000, env = {}, until }) {
  const bin = join(dshRoot(), 'lib', 'bin.js')
  return new Promise((settle) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ALL_PROXY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let probing = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poller)
      child.kill('SIGKILL')
      settle({ ...outcome, stdout, stderr })
    }
    const timer = setTimeout(() => finish({ matched: false, reason: 'timeout' }), timeoutMs)
    const probe = async () => {
      if (settled || probing) return
      probing = true
      try {
        if (await until({ stdout, stderr })) finish({ matched: true, reason: 'matched' })
      } finally {
        probing = false
      }
    }
    const poller = setInterval(probe, 100)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      void probe()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      void probe()
    })
    child.on('close', (code, signal) => finish({ matched: false, reason: 'exited', code, signal }))
  })
}

/**
 * A minimal OpenAI `chat/completions` streaming server.
 *
 * It exists so the suite can prove that a migrated provider profile is not just
 * written to the patch but actually registered and used, without depending on
 * any external model service.
 *
 * @returns `{ port, requests, close }`, where `requests` records each path.
 */
export function startFakeOpenAiProvider({ reply = 'PROBE_OK' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push(req.url)
      if (!String(req.url).endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      const chunk = (delta, finish, usage) =>
        JSON.stringify({
          id: 'chatcmpl-dsh-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'flowlet-pro',
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          ...(usage === undefined ? {} : { usage }),
        })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${chunk({ role: 'assistant', content: reply }, null)}\n\n`)
      res.write(`data: ${chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((settle) => {
    server.listen(0, '127.0.0.1', () => {
      settle({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** Occupy a port so a pinned `--port` bind is guaranteed to fail. */
export function occupyPort() {
  const server = createServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  return new Promise((settle) => {
    server.listen(0, '127.0.0.1', () => {
      settle({ port: server.address().port, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** Read the id-targeted rows of a profile patch document. */
export async function readPatchRows(yaml, patchPath) {
  if (!existsSync(patchPath)) return []
  const parsed = yaml.parse(await readFile(patchPath, 'utf8'))
  return Array.isArray(parsed) ? parsed : []
}

/** The row for one entry id in a composed profile patch. */
export function rowFor(rows, id) {
  return rows.find((row) => row !== null && typeof row === 'object' && row.id === id)
}
