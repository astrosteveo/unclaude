import { createServer } from 'node:http'
import { guarded, readJson, send } from './http.js'
import { newNote, noteChanges } from './validate.js'

/** The API over a store; returns an http.Server (not yet listening). */
export function createApp({ store }) {
  const routes = [
    ['GET', /^\/notes$/, async (req, res) => send(res, 200, await store.list())],
    ['GET', /^\/notes\/([\w-]+)$/, async (req, res, [id]) => {
      const note = await store.get(id)
      return note ? send(res, 200, note) : send(res, 404, { error: 'not found' })
    }],
    ['POST', /^\/notes$/, async (req, res) => send(res, 201, await store.create(newNote(await readJson(req))))],
    ['PATCH', /^\/notes\/([\w-]+)$/, async (req, res, [id]) => {
      const note = await store.update(id, noteChanges(await readJson(req)))
      return note ? send(res, 200, note) : send(res, 404, { error: 'not found' })
    }],
    ['DELETE', /^\/notes\/([\w-]+)$/, async (req, res, [id]) =>
      (await store.remove(id)) ? send(res, 204) : send(res, 404, { error: 'not found' })],
  ]
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://local')
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pattern.exec(pathname)
      if (match) return guarded(handler)(req, res, match.slice(1))
    }
    send(res, 404, { error: 'no such route' })
  })
}
