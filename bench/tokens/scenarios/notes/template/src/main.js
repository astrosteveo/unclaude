import { createApp } from './server.js'
import { MemoryStore } from './store.js'

const port = Number(process.env.PORT ?? 3000)
const app = createApp({ store: new MemoryStore() })
app.listen(port, () => console.log(`notes-api on :${port}`))
