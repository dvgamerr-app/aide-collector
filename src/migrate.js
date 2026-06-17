import { destroy, migrate } from './db'

await migrate()
await destroy()
