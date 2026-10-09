import { ValidationError } from './validate.js'

export const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(data === undefined ? '' : JSON.stringify(data))
}

export async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new ValidationError('body is not valid JSON')
  }
}

/** Runs a handler, turning thrown errors into JSON error responses. */
export const guarded = handler => async (req, res, params) => {
  try {
    await handler(req, res, params)
  } catch (err) {
    if (err instanceof ValidationError) return send(res, 400, { error: err.message })
    console.error(err)
    send(res, 500, { error: 'internal error' })
  }
}
