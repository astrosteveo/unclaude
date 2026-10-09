export class ValidationError extends Error {}

const text = (value, field, max) => {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  if (value.trim() === '') throw new ValidationError(`${field} must not be empty`)
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return value.trim()
}

/** A new note's fields, checked. */
export function newNote(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('body must be a JSON object')
  return { title: text(input.title, 'title', 200), body: input.body === undefined ? '' : text(input.body, 'body', 10_000) }
}

/** The fields a PATCH may change, checked; at least one. */
export function noteChanges(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('body must be a JSON object')
  const out = {}
  if ('title' in input) out.title = text(input.title, 'title', 200)
  if ('body' in input) out.body = text(input.body, 'body', 10_000)
  if (Object.keys(out).length === 0) throw new ValidationError('nothing to change')
  return out
}
