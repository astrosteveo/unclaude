import { randomUUID } from 'node:crypto'

/** Notes held in memory, lost on restart. */
export class MemoryStore {
  #notes = new Map()

  async list() {
    return [...this.#notes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(id) {
    return this.#notes.get(id) ?? null
  }

  async create({ title, body }) {
    const now = new Date().toISOString()
    const note = { id: randomUUID(), title, body, createdAt: now, updatedAt: now }
    this.#notes.set(note.id, note)
    return note
  }

  async update(id, changes) {
    const note = this.#notes.get(id)
    if (!note) return null
    const next = { ...note, ...changes, updatedAt: new Date().toISOString() }
    this.#notes.set(id, next)
    return next
  }

  async remove(id) {
    return this.#notes.delete(id)
  }
}
