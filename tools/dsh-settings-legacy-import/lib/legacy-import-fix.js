/**
 * Transactional replacement for the published `importLegacyDocument()` of
 * `@deepseek-ai/dsh-settings` 0.2.0-rc.2.
 *
 * Why this exists
 * ---------------
 * The published method (see `lib/index.js`, `SettingsForms#importLegacyDocument`)
 * is not crash-safe and is not transactional:
 *
 *   1. it renames `<DSH_HOME>/settings.yaml` to `settings.yaml.imported`
 *      *before* it attempts any write;
 *   2. it imports each top-level section independently, logging a warning and
 *      continuing when one fails;
 *   3. it never rolls back an already-written section and never restores the
 *      renamed document.
 *
 * Whatever the cause of a failing section, the outcome is the same: the only
 * copy of the user's legacy settings is consumed and the composition is left
 * half-migrated. A section that declares provider routes can fail while the
 * `agent-default-model` section that references those routes succeeds, which
 * commits a default model pointing at a provider with no registered adapter
 * (`no adapter registered for provider "…"`, LlmError code `NO_ADAPTER`).
 * It also runs when the boot has already failed: when the startup audit
 * rejects the tree the settings service's context is disposed mid-flight, every
 * `update()` throws `cannot get required service "configEditor" in inactive
 * context`, and the document has already been renamed away — zero sections
 * imported, nothing left to retry with.
 *
 * What this replacement guarantees
 * --------------------------------
 *   - `settings.yaml` is renamed to `settings.yaml.imported` **only after every
 *     section imported successfully**. Until then the document stays in place,
 *     so the next healthy boot retries (and re-applying is idempotent because
 *     each section is a merge, not a replace).
 *   - The whole document is one commit unit: the provider-declaring sections
 *     (`llm-pi-ai`, `llm-deepseek`) and the dependent `agent-default-model`
 *     section are validated and committed together, and any failed write rolls
 *     back every section already written.
 *   - A default model may never be committed while the provider it names has no
 *     route. This is checked twice: before writing (against the planned route
 *     set plus the adapters' declared routes) and after writing (against the
 *     live `llm` adapter registry, with a bounded wait for the settings-driven
 *     registration to land).
 *   - When the host context is already inactive (a failed startup is tearing
 *     the tree down) the migration aborts without touching anything.
 *   - Failures produce `<DSH_HOME>/settings.yaml.import-error.json`, a
 *     machine-readable ledger naming the failing section, the entry id, the
 *     phase, the error, what was applied and rolled back, and the remedy.
 *
 * The function is deliberately written against the same host surface the
 * published method uses (`this.ownerContext`, `this.update`, `this.documentPath`)
 * so it can be installed as a drop-in override.
 *
 * @module tools/dsh-settings-legacy-import/lib/legacy-import-fix
 */

import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Removed `settings.yaml` sections whose owning profile entry carries another id.
 * Mirrors the upstream table; keep in sync when upstream adds a mapping.
 */
export const LEGACY_SECTION_ENTRIES = {
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox',
}

/** Sections that declare provider routes; `llm-deepseek` is single-route. */
export const PROVIDER_SECTIONS = ['llm-pi-ai', 'llm-deepseek']

/** The native route the `llm-deepseek` section configures. */
export const NATIVE_DEEPSEEK_ROUTE = 'deepseek-official'

/** The section whose `provider`/`model` reference must resolve after the import. */
export const DEFAULT_MODEL_SECTION = 'agent-default-model'

/**
 * Commit order for the dependency unit: every section that declares provider
 * routes first, the default model that names one of them last. The order is
 * independent of the order the sections appear in the document.
 */
const UNIT_ORDER = [...PROVIDER_SECTIONS, DEFAULT_MODEL_SECTION]

/** Commit weight for one section; unknown sections sort last. */
function unitWeight(section) {
  const index = UNIT_ORDER.indexOf(section)
  return index < 0 ? UNIT_ORDER.length : index
}

/** Name of the failure ledger written next to the legacy document. */
export const FAILURE_REPORT_FILENAME = 'settings.yaml.import-error.json'

/** Bounded wait for the settings-driven provider registration to become observable. */
const REGISTRATION_WAIT_MS = 5000
const REGISTRATION_POLL_MS = 50

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve the YAML implementation lazily from the host package's own dependency. */
async function defaultYaml() {
  return await import('yaml')
}

/** Message of an unknown throwable. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message ?? String(error)
}

/** Whether a parsed YAML root is a plain mapping of settings sections. */
function isPlainDocument(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether the owner context can still be used; a disposed context throws on service access. */
export function isHostActive(host) {
  try {
    if (host.closed === true) return false
    const state = host.ownerContext?.fiber?.state
    if (state !== undefined && state !== 2) return false
    return true
  } catch {
    return false
  }
}

/** Read `ownerContext.configEditor`, or `undefined` when the context is already inactive. */
export function editorOrUndefined(host) {
  try {
    return host.ownerContext?.configEditor ?? undefined
  } catch {
    return undefined
  }
}

/** Read a cordis service by name without injecting it, or `undefined`. */
function serviceOrUndefined(host, name) {
  for (const holder of [host.ownerContext, host.ctx]) {
    try {
      const gotten = holder?.get?.(name)
      if (gotten !== undefined && gotten !== null) return gotten
    } catch {
      /* an inactive context throws; try the next holder */
    }
  }
  return undefined
}

/**
 * Provider routes the adapters currently declare, registered or dormant.
 * @returns route -> declaring settings namespace, when the registry answers.
 */
export function declaredRoutes(host) {
  const routes = new Map()
  const llm = serviceOrUndefined(host, 'llm')
  if (llm === undefined || typeof llm.listConfigurableProviders !== 'function') return routes
  try {
    for (const entry of llm.listConfigurableProviders()) {
      if (entry !== null && typeof entry === 'object' && typeof entry.provider === 'string') {
        routes.set(entry.provider, entry.settingsNs)
      }
    }
  } catch {
    /* a diagnostic surface must never abort the migration */
  }
  return routes
}

/**
 * Plan a legacy document: which sections to import under which entry id, which
 * provider routes the document itself introduces, and which default model the
 * document asks for.
 *
 * Pure and synchronous so tests can assert the plan without a running tree.
 *
 * @param document Parsed `settings.yaml` root.
 * @returns The plan.
 */
export function planLegacyImport(document) {
  const sections = Object.entries(document ?? {}).map(([section, values]) => ({
    section,
    values,
    entry: LEGACY_SECTION_ENTRIES[section] ?? section,
    unit: PROVIDER_SECTIONS.includes(section) || section === DEFAULT_MODEL_SECTION,
  }))

  /** Routes this document introduces: provider key -> declared model ids (or undefined). */
  const introduced = new Map()
  for (const { section, values } of sections) {
    if (section === 'llm-pi-ai') {
      const providers = values?.providers
      if (Array.isArray(providers)) {
        // The pre-0.2 array form is rejected by the adapter's own resolver; the
        // write fails and the unit rolls back, which is the correct outcome.
        continue
      }
      for (const [route, profile] of Object.entries(providers ?? {})) {
        const models = Array.isArray(profile?.models)
          ? profile.models.map((model) => model?.id).filter((id) => typeof id === 'string')
          : undefined
        introduced.set(route, models)
      }
    } else if (section === 'llm-deepseek') {
      introduced.set(NATIVE_DEEPSEEK_ROUTE, undefined)
    }
  }

  const defaultModelSection = sections.find(({ section }) => section === DEFAULT_MODEL_SECTION)
  const provider = defaultModelSection?.values?.provider
  const model = defaultModelSection?.values?.model

  return {
    sections,
    /** The dependency unit: provider sections plus the default-model section. */
    unit: sections.filter(({ unit }) => unit),
    /** Sections that no other section depends on. */
    independent: sections.filter(({ unit }) => !unit),
    introduced,
    defaultModel:
      defaultModelSection !== undefined && typeof provider === 'string' && provider.length > 0
        ? { provider, model: typeof model === 'string' ? model : undefined, section: DEFAULT_MODEL_SECTION }
        : undefined,
  }
}

/**
 * Whether the planned composition would give the requested default model a
 * provider route: either an adapter already declares the route, or the legacy
 * document itself declares it.
 *
 * @returns `{ ok, reason }`; `reason` explains a refusal.
 */
export function checkDefaultModelRoute(plan, host) {
  const requested = plan.defaultModel
  if (requested === undefined) return { ok: true }
  const declared = declaredRoutes(host)
  const byDocument = plan.introduced.has(requested.provider)
  // An empty answer means the registry could not be consulted in this
  // composition, not that no adapter declares any route; the post-commit live
  // check still guards that case.
  if (!byDocument && declared.size > 0 && !declared.has(requested.provider)) {
    const known = [...new Set([...declared.keys(), ...plan.introduced.keys()])].sort()
    return {
      ok: false,
      reason:
        `agent-default-model requests provider "${requested.provider}", but no profile entry registers ` +
        `an adapter for it and the legacy document does not declare it either ` +
        `(known routes: ${known.length === 0 ? 'none' : known.join(', ')})`,
    }
  }
  if (byDocument && requested.model !== undefined) {
    const models = plan.introduced.get(requested.provider)
    if (Array.isArray(models) && !models.includes(requested.model)) {
      return {
        ok: false,
        reason:
          `agent-default-model requests model "${requested.model}", which the legacy llm-pi-ai profile for ` +
          `provider "${requested.provider}" does not list (listed: ${models.length === 0 ? 'none' : models.join(', ')})`,
      }
    }
  }
  return { ok: true }
}

/** Wait until `llm.listProviders()` reports the route, or the bounded budget expires. */
async function waitForRegisteredProvider(host, provider, budgetMs) {
  const llm = serviceOrUndefined(host, 'llm')
  if (llm === undefined || typeof llm.listProviders !== 'function') return 'unknown'
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      // `LlmProviderInfo` carries the route as `id`; `provider` is accepted too
      // so the probe keeps working if the shape is widened.
      if (llm.listProviders().some((info) => (info?.id ?? info?.provider) === provider)) return 'registered'
    } catch {
      return 'unknown'
    }
    if (Date.now() >= deadline) return 'absent'
    await sleep(REGISTRATION_POLL_MS)
  }
}

/** The raw profile config an entry currently holds, or `undefined` when it is not addressable. */
function entrySnapshot(host, entryId) {
  const editor = editorOrUndefined(host)
  if (editor === undefined || typeof editor.entries !== 'function') return { found: false }
  let entries
  try {
    entries = editor.entries()
  } catch {
    return { found: false }
  }
  const entry = entries.find((row) => row.options?.id === entryId)
  if (entry === undefined) return { found: false }
  return { found: true, entry, config: structuredClone(entry.options?.config ?? {}) }
}

/** Write the machine-readable failure ledger; never throws. */
async function writeFailureReport(host, payload) {
  try {
    const home = host.ownerContext?.profileContext?.home
    if (typeof home !== 'string' || home.length === 0) return undefined
    const path = join(home, FAILURE_REPORT_FILENAME)
    const document = {
      version: 1,
      kind: 'dsh-settings-legacy-import',
      outcome: 'failed',
      timestamp: new Date().toISOString(),
      profile: host.ownerContext?.profileContext?.name ?? null,
      home,
      legacyDocument: join(home, 'settings.yaml'),
      legacyDocumentConsumed: false,
      patchDocument: safeDocumentPath(host),
      appliedAndRolledBack: payload.applied.map(({ section, entry }) => ({ section, entry })),
      failures: payload.failures,
      rollbackFailures: payload.rollbackFailures,
      remedy: payload.remedy,
    }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/** `documentPath` is a getter that can throw on an inactive context. */
function safeDocumentPath(host) {
  try {
    return host.documentPath ?? null
  } catch {
    return null
  }
}

/** Remove a stale ledger after a fully successful migration. */
async function clearFailureReport(host) {
  try {
    const home = host.ownerContext?.profileContext?.home
    if (typeof home !== 'string' || home.length === 0) return
    await unlink(join(home, FAILURE_REPORT_FILENAME))
  } catch {
    /* absence is the normal case */
  }
}

/**
 * Move the removed `settings.yaml` sections into the active profile — transactionally.
 *
 * Install as `SettingsForms.prototype.importLegacyDocument`; it is called with the
 * service instance as `this` and the same arguments (none) as the published method.
 *
 * @param options.yaml Optional `{ parse }` override; defaults to the package's `yaml`.
 * @param options.registrationWaitMs Optional bound (ms) on the post-commit live provider check.
 * @returns Resolves after the import either committed or was fully rolled back.
 */
export async function importLegacyDocument(options = {}) {
  const host = this
  const profile = host.ownerContext.profileContext
  const path = join(profile.home, 'settings.yaml')
  if (!existsSync(path)) return

  const imported = `${path}.imported`
  if (existsSync(imported)) {
    // A previous run finished the migration; a fresh settings.yaml is a new
    // document the current settings provider owns, not a legacy one.
    return
  }

  const logger = host.ownerContext.logger
  const yaml = options.yaml ?? (await defaultYaml())

  let document
  try {
    document = yaml.parse(await readFile(path, 'utf8'))
  } catch (error) {
    logger.error(
      'settings: %s could not be parsed and was left in place: %s',
      path,
      messageOf(error),
    )
    await writeFailureReport(host, {
      applied: [],
      failures: [{ section: null, entry: null, phase: 'parse', message: messageOf(error) }],
      rollbackFailures: [],
      remedy: [
        `${path} is not valid YAML and was not consumed. Fix or remove it and restart dsh.`,
      ],
    })
    return
  }

  const plan = planLegacyImport(isPlainDocument(document) ? document : {})
  if (!isPlainDocument(document)) {
    logger.error('settings: %s does not hold a section mapping and was left in place', path)
    await writeFailureReport(host, {
      applied: [],
      failures: [
        {
          section: null,
          entry: null,
          phase: 'parse',
          message: 'the document root is not a mapping of sections',
        },
      ],
      rollbackFailures: [],
      remedy: [`Rewrite ${path} as a mapping of settings sections, or remove it, then restart dsh.`],
    })
    return
  }
  if (plan.sections.length === 0) {
    // Nothing to import; consuming the empty document is the upstream contract.
    await rename(path, imported)
    await clearFailureReport(host)
    logger.info('settings: imported %s into profile %s', imported, profile.name)
    return
  }

  if (!isHostActive(host)) {
    logger.warn(
      'settings: %s was left in place: the profile tree is no longer active, so this boot cannot ' +
        'accept the migration. Restart dsh after resolving the startup error.',
      path,
    )
    await writeFailureReport(host, {
      applied: [],
      failures: [
        {
          section: null,
          entry: null,
          phase: 'preflight',
          message: 'the settings service context is inactive (startup is tearing the tree down)',
        },
      ],
      rollbackFailures: [],
      remedy: [
        'Nothing was imported and the legacy document was not consumed.',
        'Resolve the startup failure reported by dsh, then restart it: the migration retries automatically.',
      ],
    })
    return
  }

  if (editorOrUndefined(host) === undefined) {
    logger.warn(
      'settings: %s was left in place: the config editor service is unavailable in this profile, ' +
        'so the sections cannot be written to %s.',
      path,
      profile.dir,
    )
    await writeFailureReport(host, {
      applied: [],
      failures: [
        {
          section: null,
          entry: null,
          phase: 'preflight',
          message: 'the configEditor service is unavailable',
        },
      ],
      rollbackFailures: [],
      remedy: [
        'Nothing was imported and the legacy document was not consumed.',
        'Boot a profile that mounts @deepseek-ai/dsh-config-editor (dsh-base does) and restart dsh.',
      ],
    })
    return
  }

  // Refuse before writing anything when the composition cannot serve the
  // requested default model. This is what makes a dangling
  // "provider with no adapter" default model impossible by construction.
  const routeCheck = checkDefaultModelRoute(plan, host)
  if (!routeCheck.ok) {
    logger.error('settings: refusing to import %s: %s', path, routeCheck.reason)
    await writeFailureReport(host, {
      applied: [],
      failures: [
        { section: DEFAULT_MODEL_SECTION, entry: DEFAULT_MODEL_SECTION, phase: 'preflight', message: routeCheck.reason },
      ],
      rollbackFailures: [],
      remedy: [
        'Nothing was imported and the legacy document was not consumed.',
        `Add the missing provider route to ${safeDocumentPath(host) ?? 'the profile patch'}, or remove the agent-default-model section from ${path}.`,
      ],
    })
    return
  }

  // Dependency unit first: the provider sections must land before the default
  // model that names them, and the unit commits all-or-nothing.
  const ordered = [
    ...[...plan.unit].sort((a, b) => unitWeight(a.section) - unitWeight(b.section)),
    ...plan.independent,
  ]
  const applied = []
  const failures = []
  const rollbackFailures = []

  const rollback = async () => {
    const editor = editorOrUndefined(host)
    if (editor === undefined) {
      rollbackFailures.push({
        section: null,
        entry: null,
        message: 'the configEditor service became unavailable; nothing could be rolled back',
      })
      return
    }
    for (const record of [...applied].reverse()) {
      const current = entrySnapshot(host, record.entry)
      if (!current.found) {
        rollbackFailures.push({
          section: record.section,
          entry: record.entry,
          message: 'the profile entry disappeared before it could be rolled back',
        })
        continue
      }
      try {
        const before = record.before
        await editor.edit(current.entry, () => structuredClone(before))
      } catch (error) {
        rollbackFailures.push({
          section: record.section,
          entry: record.entry,
          message: messageOf(error),
        })
      }
    }
  }

  for (const { section, values, entry: entryId } of ordered) {
    if (!isHostActive(host)) {
      failures.push({
        section,
        entry: entryId,
        phase: 'write',
        message: 'the settings service context became inactive while the migration was running',
      })
      break
    }
    const snapshot = entrySnapshot(host, entryId)
    if (!snapshot.found) {
      failures.push({
        section,
        entry: entryId,
        phase: 'resolve',
        message: `no configurable profile entry "${entryId}" in this composition`,
      })
      break
    }
    try {
      await host.update(entryId, values)
      applied.push({ section, entry: entryId, before: snapshot.config })
    } catch (error) {
      failures.push({ section, entry: entryId, phase: 'write', message: messageOf(error) })
      break
    }
  }

  if (failures.length === 0 && plan.defaultModel !== undefined) {
    const budget = Number.isFinite(options.registrationWaitMs) ? options.registrationWaitMs : REGISTRATION_WAIT_MS
    const verdict = await waitForRegisteredProvider(host, plan.defaultModel.provider, budget)
    if (verdict === 'absent') {
      failures.push({
        section: DEFAULT_MODEL_SECTION,
        entry: DEFAULT_MODEL_SECTION,
        phase: 'verify',
        message:
          `provider "${plan.defaultModel.provider}" still has no registered adapter after the import, ` +
          'so the default model would fail with NO_ADAPTER',
      })
    } else if (verdict === 'unknown') {
      logger.warn(
        'settings: could not confirm that provider %s is registered; continuing because the legacy ' +
          'document declares its route',
        plan.defaultModel.provider,
      )
    }
  }

  if (failures.length > 0) {
    await rollback()
    const reportPath = await writeFailureReport(host, {
      applied,
      failures,
      rollbackFailures,
      remedy: [
        `Nothing was imported: every section that had been written was rolled back and ${path} was left in place.`,
        'Fix or remove the failing section and restart dsh; the migration retries automatically and re-applying a section is idempotent.',
        `A machine-readable ledger of this failure is written as ${FAILURE_REPORT_FILENAME} next to the document.`,
      ],
    })
    logger.error(
      'settings: legacy import of %s failed (%s); %d section(s) rolled back, document left in place%s',
      path,
      failures.map((failure) => `${failure.section ?? '<document>'}: ${failure.message}`).join('; '),
      applied.length,
      reportPath === undefined ? '' : `, report: ${reportPath}`,
    )
    for (const rollbackFailure of rollbackFailures) {
      logger.error(
        'settings: could not roll back section %s: %s',
        rollbackFailure.section ?? '<unknown>',
        rollbackFailure.message,
      )
    }
    return
  }

  await rename(path, imported)
  await clearFailureReport(host)
  logger.info(
    'settings: imported %s into profile %s (%d section(s))',
    imported,
    profile.name,
    applied.length,
  )
}

export default importLegacyDocument
