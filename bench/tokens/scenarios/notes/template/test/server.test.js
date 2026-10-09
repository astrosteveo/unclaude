import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start } from './helpers.js'

test('create, read, list, update and delete a note', async () => {
  const { call, stop } = await start()
  try {
    const made = await call('POST', '/notes', { title: 'First', body: 'hello' })
    assert.equal(made.status, 201)
    assert.equal((await call('GET', `/notes/${made.body.id}`)).body.title, 'First')
    await call('POST', '/notes', { title: 'Second' })
    assert.deepEqual((await call('GET', '/notes')).body.map(n => n.title).sort(), ['First', 'Second'])
    assert.equal((await call('PATCH', `/notes/${made.body.id}`, { title: 'Renamed' })).body.title, 'Renamed')
    assert.equal((await call('DELETE', `/notes/${made.body.id}`)).status, 204)
    assert.equal((await call('GET', `/notes/${made.body.id}`)).status, 404)
  } finally {
    await stop()
  }
})

test('bad input is a 400 with a message', async () => {
  const { call, stop } = await start()
  try {
    assert.deepEqual(await call('POST', '/notes', { title: '' }).then(r => [r.status, r.body.error]), [400, 'title must not be empty'])
    assert.equal((await call('PATCH', '/notes/x', {})).status, 400)
  } finally {
    await stop()
  }
})
