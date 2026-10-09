import { createApp } from '../src/server.js'
import { MemoryStore } from '../src/store.js'

/** Starts the app on a free port; returns a fetch-like client and a stop function. */
export async function start(store = new MemoryStore()) {
  const server = createApp({ store })
  await new Promise(resolve => server.listen(0, resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined }
  }
  return { call, stop: () => new Promise(resolve => server.close(resolve)) }
}
