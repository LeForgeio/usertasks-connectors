/**
 * The shared engine for every action in this repository.
 *
 * Each action has a spec.json that lists REST calls (method, path, query,
 * body). This module turns a spec into a UserTasks action definition. The
 * build writes the server URL into the module (BASE_URL below), so the
 * action calls only the server that you packaged it for.
 *
 * The token goes in the header as `Bearer secret://api_token`. The host puts
 * the secret value in. For an action whose token is optional (ntfy), the
 * engine first asks the host whether the secret has a value. That read is
 * the only place where the value enters the sandbox, and the engine does
 * not keep it.
 */
import type { ActionContext, ActionDefinition, ActionHttpInit } from '../vendor/usertasks-action/index'

/** The build replaces this name with the server URL (esbuild define). */
declare const __BASE_URL__: string

export interface SpecField {
  name: string
  type: string
  required?: boolean
  description?: string
  default?: unknown
}

export interface SpecOperation {
  id: string
  label: string
  description?: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query_fixed?: Record<string, string>
  query?: Array<{ param: string; input: string }>
  headers?: Record<string, string>
  body?: string | null
  inputs: SpecField[]
  outputs: SpecField[]
}

export interface Spec {
  key: string
  name: string
  auth: { optional?: boolean }
  operations: SpecOperation[]
}

/** The name of the one secret that every action declares. */
export const TOKEN_SECRET = 'api_token'

const OMIT = Symbol('omit')
const PLACEHOLDER = /\{\{(\w+)\}\}/g

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** Give a JSON value. A string that holds JSON text is parsed. */
function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (text === '') return OMIT
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

/** Put input values into a text with {{name}} placeholders. */
function interpolate(text: string, inputs: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_, name: string) => (isEmpty(inputs[name]) ? '' : String(inputs[name])))
}

/**
 * Fill a parsed body template. A key whose input is empty is removed, so
 * the server uses its own default and does not get an empty string.
 */
function fill(node: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => fill(n, inputs)).filter((n) => n !== OMIT)
  if (node && typeof node === 'object') {
    const marker = node as { __q?: string; __raw?: string }
    if (typeof marker.__q === 'string') {
      const value = inputs[marker.__q]
      return isEmpty(value) ? OMIT : String(value)
    }
    if (typeof marker.__raw === 'string') {
      const value = inputs[marker.__raw]
      return isEmpty(value) ? OMIT : asJson(value)
    }
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node)) {
      const value = fill(child, inputs)
      if (value !== OMIT) out[key] = value
    }
    return out
  }
  if (typeof node === 'string' && node.includes('{{')) return interpolate(node, inputs)
  return node
}

/**
 * Mark the placeholders in a JSON body template so that JSON.parse can
 * read it. The scan follows JSON strings:
 * - a string that is only "{{name}}" becomes {"__q": name} (a string value);
 * - a bare {{name}} outside a string becomes {"__raw": name} (a JSON value);
 * - a {{name}} inside a longer string stays, and fill() puts the text in.
 */
export function markTemplate(template: string): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    if (ch === '"') {
      let j = i + 1
      while (j < template.length && template[j] !== '"') j += template[j] === '\\' ? 2 : 1
      const literal = template.slice(i, j + 1)
      const only = /^"\{\{(\w+)\}\}"$/.exec(literal)
      out += only ? JSON.stringify({ __q: only[1] }) : literal
      i = j + 1
    } else if (ch === '{' && template[i + 1] === '{') {
      const m = /^\{\{(\w+)\}\}/.exec(template.slice(i))
      if (!m) throw new Error(`Bad placeholder in the body template at ${i}`)
      out += JSON.stringify({ __raw: m[1] })
      i += m[0].length
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * Make the request body from the template.
 * - `{{name}}` alone: the value as text (text content type) or as JSON.
 * - A JSON template: "{{name}}" becomes a string, a bare {{name}} becomes
 *   a JSON value (number, boolean, list or object).
 */
export function buildBody(template: string | null | undefined, inputs: Record<string, unknown>, contentType: string, ctx: Pick<ActionContext, 'fail'>): string | undefined {
  if (!template) return undefined
  const whole = /^\s*\{\{(\w+)\}\}\s*$/.exec(template)
  if (!whole) return JSON.stringify(fill(JSON.parse(markTemplate(template)), inputs))
  const name = whole[1]
  const value = inputs[name]
  if (isEmpty(value)) return undefined
  if (contentType.startsWith('text/')) return typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof value === 'string') {
    try {
      JSON.parse(value)
    } catch {
      ctx.fail(`${name} is not valid JSON`)
    }
    return value.trim()
  }
  return JSON.stringify(value)
}

/** Make the full URL: the path values are encoded, empty query values are left out. */
export function buildUrl(base: string, op: SpecOperation, inputs: Record<string, unknown>, ctx: Pick<ActionContext, 'fail'>): string {
  const path = op.path.replace(PLACEHOLDER, (_, name: string) => {
    const value = inputs[name]
    if (isEmpty(value)) ctx.fail(`${name} is required`)
    return encodeURIComponent(String(value))
  })
  const parts: string[] = []
  for (const [key, value] of Object.entries(op.query_fixed ?? {})) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  for (const { param, input } of op.query ?? []) {
    const value = inputs[input]
    if (!isEmpty(value)) parts.push(`${encodeURIComponent(param)}=${encodeURIComponent(String(value))}`)
  }
  return `${base.replace(/\/+$/, '')}${path}${parts.length ? `?${parts.join('&')}` : ''}`
}

/** The outputs that every operation returns. Spec outputs cannot use these names. */
export const STANDARD_OUTPUTS = ['http_status', 'http_ok', 'response'] as const

/** Read the declared outputs from the response, plus the standard outputs. */
export function readOutputs(op: SpecOperation, status: number, ok: boolean, data: unknown): Record<string, unknown> {
  const outputs: Record<string, unknown> = {}
  const arrays = op.outputs.filter((o) => o.type === 'array')
  for (const field of op.outputs) {
    if (Array.isArray(data)) outputs[field.name] = field.type === 'array' && arrays.length === 1 ? data : null
    else if (data && typeof data === 'object') outputs[field.name] = (data as Record<string, unknown>)[field.name] ?? null
    else outputs[field.name] = null
  }
  // The standard outputs go last, so a body field cannot replace them.
  return { ...outputs, http_status: status, http_ok: ok, response: data }
}

/** True when the token secret has a value. Only an optional-token action asks. */
async function tokenIsSet(ctx: ActionContext): Promise<boolean> {
  try {
    return (await ctx.secrets.get(`secret://${TOKEN_SECRET}`)) !== ''
  } catch {
    return false
  }
}

async function call(spec: Spec, op: SpecOperation, inputs: Record<string, unknown>, ctx: ActionContext) {
  const url = buildUrl(__BASE_URL__, op, inputs, ctx)
  const headers: Record<string, string> = { Accept: 'application/json', ...(op.headers ?? {}) }
  const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const body = buildBody(op.body, inputs, contentType || 'application/json', ctx)
  if (body !== undefined && !contentType) headers['Content-Type'] = 'application/json'
  // A server that needs no token (for example a public ntfy server) gets no
  // Authorization header when the token is empty. Otherwise the host puts the
  // secret into the header, and a missing secret fails the step.
  const login = !spec.auth.optional || (await tokenIsSet(ctx))
  if (login) headers.Authorization = `Bearer secret://${TOKEN_SECRET}`
  const init: ActionHttpInit = { method: op.method, headers, body }

  const res = await ctx.http.fetch(url, init)
  const data = res.json ?? (res.text === '' ? null : res.text)
  if (!res.ok) {
    const detail = (typeof data === 'string' ? data : JSON.stringify(data) ?? '').slice(0, 300)
    ctx.fail(`${spec.name} ${op.label}: HTTP ${res.status} ${detail}`.trim(), { retryable: res.status >= 500 || res.status === 429 })
  }
  ctx.log.info(`${op.method} ${op.path} -> ${res.status}`)
  return readOutputs(op, res.status, res.ok, data)
}

/** Turn a spec into the action's default export. */
export function restAction(spec: Spec): ActionDefinition {
  const operations: ActionDefinition['operations'] = {}
  for (const op of spec.operations) {
    operations[op.id] = (inputs: Record<string, unknown>, ctx: ActionContext) => call(spec, op, inputs ?? {}, ctx)
  }
  return { operations }
}
