import { destroy, migrate, migrateDown } from './db'

const isDown = process.argv.includes('--down')
await (isDown ? migrateDown() : migrate())
await destroy()
