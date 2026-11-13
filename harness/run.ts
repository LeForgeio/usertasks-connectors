/**
 * The test harness: node .harness/run.mjs <dist dir> <action dir> [--verbose]
 *
 * It runs the BUILT module (dist/<name>/dist/action.js, what you upload) in
 * the same QuickJS WebAssembly sandbox that UserTasks uses:
 *
 *   1. Each operation once with its example inputs, against a mock server
 *      that answers 200 {}. Every declared output must come back.
 *   2. Each case in <action dir>/test/cases.json. A case can check the
 *      request (`expect_request`), the outputs (`expect`) or an error code
 *      (`expect_error`).
 *
 * The secret api_token is "test-token" unless a case gives its own
 * `mocks.secrets` (give {} to test a call with no token set).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionField, ActionManifest, ActionRunResult } from '../vendor/usertasks-action/contract'
import { HostServiceError, runAction, type ActionMocks } from '../vendor/usertasks-action/testing'

interface HttpReply { status?: number; headers?: Record<string, string>; text?: string; json?: unknown }

interface ExpectedRequest {
  method?: string
  url?: string
  headers?: Record<string, string | null>
  /** A string is compared as text; anything else is compared as parsed JSON. */
  body?: unknown
}

interface TestCase {
  name?: string
  operation: string
  inputs?: Record<string, unknown>
  expect?: Record<string, unknown>
  expect_error?: string | boolean
  expect_request?: ExpectedRequest
  mocks?: Omit<ActionMocks, 'http'> & { http?: HttpReply }
}

interface SeenRequest { url: string; init: Record<string, unknown> }

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const [outDir, actionDir] = args.filter((a) => !a.startsWith('--'))

const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as ActionManifest
const module = readFileSync(join(outDir, manifest.entry ?? 'dist/action.js'), 'utf8')
const casesFile = join(actionDir, 'test', 'cases.json')
const cases: TestCase[] = existsSync(casesFile) ? (JSON.parse(readFileSync(casesFile, 'utf8')).cases ?? []) : []

let passed = 0
let failed = 0

const declaredSecrets = new Set((manifest.capabilities?.credentials ?? []).map((c) => c.name))

/**
 * Put the secret into a header value as the UserTasks host does
 * (lib/custom-actions/host.ts): only `secret://name` or `Bearer secret://name`,
 * only for a declared name, and an error when no value is set.
 */
function substitute(value: string, secrets: Record<string, string>): string {
  const ref = /^(Bearer\s+)?secret:\/\/([a-z][a-z0-9_]{1,62})$/i.exec(value.trim())
  if (!ref) return value
  const name = ref[2]
  if (!declaredSecrets.has(name)) throw new HostServiceError(`secret://${name} is not declared in the manifest`, 'capability')
  if (!secrets[name]) throw new HostServiceError(`The secret "${name}" has not been set — an administrator sets it in Extensibility → Workflow actions`, 'host')
  return `${ref[1] ?? ''}${secrets[name]}`
}

function mocksFor(testCase: Partial<TestCase>, seen: SeenRequest[]): ActionMocks {
  const { http, secrets, ...rest } = testCase.mocks ?? {}
  const values = (secrets ?? { api_token: 'test-token' }) as Record<string, string>
  return {
    ...rest,
    secrets: values,
    http: (url, init) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, substitute(String(v), values)]))
      seen.push({ url, init: { ...init, headers } })
      return http ?? { status: 200, json: {} }
    },
  }
}

function typeProblem(field: ActionField, value: unknown): string | null {
  if (value === null || value === undefined) return null
  const t = field.type
  if ((t === 'number' || t === 'integer') && typeof value !== 'number') return `${field.name} should be a number`
  if (t === 'boolean' && typeof value !== 'boolean') return `${field.name} should be a boolean`
  if (['string', 'text', 'date', 'datetime', 'select'].includes(t) && typeof value !== 'string') return `${field.name} should be a string`
  if (t === 'array' && !Array.isArray(value)) return `${field.name} should be an array`
  return null
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function requestProblems(want: ExpectedRequest, seen: SeenRequest[]): string[] {
  const last = seen[seen.length - 1]
  if (!last) return ['no HTTP request was sent']
  const problems: string[] = []
  const method = String(last.init.method ?? 'GET')
  if (want.method && want.method !== method) problems.push(`method: expected ${want.method}, got ${method}`)
  if (want.url && want.url !== last.url) problems.push(`url: expected ${want.url}, got ${last.url}`)
  const headers = Object.fromEntries(Object.entries((last.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
  for (const [key, value] of Object.entries(want.headers ?? {})) {
    const got = headers[key.toLowerCase()]
    if (value === null ? got !== undefined : got !== value) problems.push(`header ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`)
  }
  if ('body' in want) {
    const body = last.init.body as string | undefined
    if (typeof want.body === 'string' || want.body === null) {
      if ((body ?? null) !== want.body) problems.push(`body: expected ${JSON.stringify(want.body)}, got ${JSON.stringify(body)}`)
    } else {
      let parsed: unknown
      try { parsed = body === undefined ? undefined : JSON.parse(body) } catch { parsed = body }
      if (!same(parsed, want.body)) problems.push(`body: expected ${JSON.stringify(want.body)}, got ${body}`)
    }
  }
  return problems
}

function report(label: string, result: ActionRunResult, problems: string[]): void {
  const timing = `${result.stats.duration_ms} ms, ${result.stats.host_calls} host calls`
  if (problems.length) {
    failed++
    console.log(`  FAIL  ${label}  (${timing})`)
    for (const p of problems) console.log(`          ${p}`)
  } else {
    passed++
    console.log(`  ok    ${label}  (${timing})`)
  }
  if (verbose || problems.length) {
    if (result.ok) console.log(`          outputs: ${JSON.stringify(result.outputs).slice(0, 500)}`)
    for (const log of result.logs) console.log(`          [${log.level}] ${log.message}`)
  }
}

console.log(`\n${manifest.key} ${manifest.version} (${manifest.operations.length} operations)`)
for (const operation of manifest.operations) {
  console.log(`${operation.id} - ${operation.label}`)
  const example = Object.fromEntries(operation.inputs.filter((f) => f.example !== undefined).map((f) => [f.name, f.example]))
  const seen: SeenRequest[] = []
  const result = await runAction({ module, manifest, operation: operation.id, inputs: example, mocks: mocksFor({}, seen) })
  const problems: string[] = []
  if (!result.ok) problems.push(`${result.error?.code}: ${result.error?.message}`)
  else {
    for (const field of operation.outputs) {
      if (!(field.name in result.outputs)) problems.push(`missing output "${field.name}"`)
      const typeError = typeProblem(field, result.outputs[field.name])
      if (typeError) problems.push(typeError)
    }
    // The mock server answers 200 {}, so the standard outputs must be exactly these.
    if (result.outputs.http_status !== 200) problems.push(`http_status: expected 200, got ${JSON.stringify(result.outputs.http_status)}`)
    if (result.outputs.http_ok !== true) problems.push(`http_ok: expected true, got ${JSON.stringify(result.outputs.http_ok)}`)
    const auth = (seen[0]?.init.headers as Record<string, string> | undefined)?.Authorization
    if (auth !== 'Bearer test-token') problems.push(`Authorization header: expected the api_token secret, got ${JSON.stringify(auth)}`)
  }
  report('example inputs', result, problems)

  for (const testCase of cases.filter((c) => c.operation === operation.id)) {
    const caseSeen: SeenRequest[] = []
    const r = await runAction({ module, manifest, operation: operation.id, inputs: testCase.inputs ?? {}, mocks: mocksFor(testCase, caseSeen) })
    const p: string[] = []
    if (testCase.expect_error !== undefined && testCase.expect_error !== false) {
      if (r.ok) p.push('expected an error, the run succeeded')
      else if (typeof testCase.expect_error === 'string' && r.error?.code !== testCase.expect_error) p.push(`expected error code ${testCase.expect_error}, got ${r.error?.code}: ${r.error?.message}`)
    } else if (!r.ok) {
      p.push(`${r.error?.code}: ${r.error?.message}`)
    } else {
      for (const [key, want] of Object.entries(testCase.expect ?? {})) {
        if (!same(r.outputs[key], want)) p.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(r.outputs[key])}`)
      }
    }
    if (testCase.expect_request) p.push(...requestProblems(testCase.expect_request, caseSeen))
    report(testCase.name ?? JSON.stringify(testCase.inputs), r, p)
  }
}

for (const testCase of cases) {
  if (!manifest.operations.some((op) => op.id === testCase.operation)) {
    failed++
    console.log(`  FAIL  ${testCase.name ?? ''}: operation "${testCase.operation}" is not in manifest.json`)
  }
}

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
