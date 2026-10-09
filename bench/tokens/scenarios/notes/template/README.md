# notes-api

A small JSON API for notes.

```
npm start            # listens on PORT (default 3000)
npm test
```

## Endpoints

- `GET /notes` lists notes, newest first
- `GET /notes/:id` reads one
- `POST /notes` creates one from `{ "title", "body" }`
- `PATCH /notes/:id` changes `title` and/or `body`
- `DELETE /notes/:id` removes one

Errors come back as `{ "error": "<message>" }` with a 4xx status.
