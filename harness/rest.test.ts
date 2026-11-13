// Unit tests for the body template scanner in lib/rest.ts (node --test).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBody, markTemplate } from '../lib/rest'

const ctx = { fail(message: string): never { throw new Error(message) } }

test('a placeholder inside a longer string stays in the string', () => {
  const body = buildBody('{"reason": "Run {{a}}, {{b}}", "n": {{n}}}', { a: 'x', b: 'y', n: 3 }, 'application/json', ctx)
  assert.deepEqual(JSON.parse(body!), { reason: 'Run x, y', n: 3 })
})

test('an escaped quote inside a string does not end the string', () => {
  assert.equal(markTemplate('{"a": "say \\"{{x}}\\"", "b": {{y}}}'), '{"a": "say \\"{{x}}\\"", "b": {"__raw":"y"}}')
})

test('a whole quoted placeholder becomes a string, empty values are left out', () => {
  const body = buildBody('{"t": "{{t}}", "u": "{{u}}", "l": [{{a}}, {{b}}]}', { t: 5, a: 1 }, 'application/json', ctx)
  assert.deepEqual(JSON.parse(body!), { t: '5', l: [1] })
})

test('a text body sends an object as JSON text', () => {
  assert.equal(buildBody('{{m}}', { m: { a: 1 } }, 'text/plain', ctx), '{"a":1}')
})

test('a JSON body input that is not JSON fails', () => {
  assert.throws(() => buildBody('{{d}}', { d: 'a: b' }, 'application/json', ctx), /d is not valid JSON/)
})
