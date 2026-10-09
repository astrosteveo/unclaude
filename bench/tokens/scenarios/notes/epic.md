Epic E1 "Notes API v2": Make notes durable, findable and exportable. Each task touches several files of the existing app (src/, test/, README.md).

T1 File persistence: Add a FileStore beside MemoryStore in src/store.js, with the same interface, that keeps notes in a JSON file.
  Checklist:
  1. FileStore.open(path) loads existing notes (or starts empty when the file is missing) and every change is written atomically (temp file, then rename)
  2. src/main.js uses FileStore when NOTES_FILE is set, else MemoryStore
  3. test/store.test.js: notes survive closing and reopening the store, no temp file is left behind, and the server tests also pass against a FileStore
  4. README.md documents NOTES_FILE

T2 Tags and search: Notes gain tags, and GET /notes can filter by tag and search text.
  Checklist:
  1. Notes have tags: an array of up to 10 lowercase strings matching [a-z0-9-]{1,30}, validated on POST and PATCH in src/validate.js and kept by both stores
  2. GET /notes?tag=x returns notes carrying tag x; ?q=text matches title or body case-insensitively; the two combine
  3. An invalid tag or an empty q is a 400 with a message
  4. test/tags.test.js covers tags, filters and errors; README.md documents them

T3 Pagination and export (blocked by T1 and T2): Page through GET /notes, and export notes as Markdown from the command line.
  Checklist:
  1. GET /notes takes limit (1-100, default 20) and offset (0 or more, default 0), applied after the filters, and sets an X-Total-Count header with the filtered total; bad values are a 400
  2. bin/export.js: `node bin/export.js <notes-file> [--tag x]` prints the file's notes newest first as Markdown (## title, the body, then a Tags: line); package.json has a bin entry for it
  3. test/pagination.test.js and test/export.test.js cover both
  4. README.md documents pagination and the export command
