import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

// IOT-Open signature — port of the Postman pre-request script. Required on /login + /refresh only.
const HDR = { appId: 'IOT-Open-AppID', bodyHash: 'IOT-Open-Body-Hash', nonce: 'IOT-Open-Nonce', sign: 'IOT-Open-Sign' }

const nonce = () => randomBytes(16).toString('hex') // 32 hex chars, like the original randomNonce(32)

// AES-128-CBC, key/iv = utf8 bytes of md5(appId) hex split at 16, zero-padding (disable PKCS, trim trailing \0)
const decryptSecret = (appId, enc) => {
  const md5 = createHash('md5').update(appId).digest('hex').toLowerCase()
  const d = createDecipheriv('aes-128-cbc', Buffer.from(md5.slice(0, 16), 'utf8'), Buffer.from(md5.slice(16), 'utf8'))
  d.setAutoPadding(false)
  return Buffer.concat([d.update(enc, 'base64'), d.final()])
    .toString('utf8')
    .replace(/\0+$/, '')
    .trim()
}

const sortedQuery = (obj) =>
  Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k]}`)
    .join('&')

export const openSign = ({ appId, body = '', encSecret, method, query = {} }) => {
  const n = nonce()
  const bodyHash = method.toUpperCase() === 'GET' ? '' : createHash('sha256').update(body, 'utf8').digest('hex').toLowerCase()
  const params = { ...query, [HDR.appId]: appId, [HDR.bodyHash]: bodyHash, [HDR.nonce]: n }
  const base64Query = Buffer.from(sortedQuery(params), 'utf8').toString('base64')
  const hmac = createHmac('sha256', decryptSecret(appId, encSecret)).update(base64Query).digest() // raw bytes
  const sign = createHash('md5').update(hmac).digest('hex').toLowerCase()
  return { [HDR.appId]: appId, [HDR.nonce]: n, [HDR.sign]: sign }
}

// self-check: encrypt with the same scheme, decrypt must round-trip; sign must be 32 hex chars.
// run: bun src/routes/stash/solar/sign.js
if (import.meta.main) {
  const appId = 'test-app-id'
  const secret = 'my-super-secret-value'
  const md5 = createHash('md5').update(appId).digest('hex').toLowerCase()
  const c = createCipheriv('aes-128-cbc', Buffer.from(md5.slice(0, 16), 'utf8'), Buffer.from(md5.slice(16), 'utf8'))
  c.setAutoPadding(false)
  const buf = Buffer.from(secret, 'utf8')
  const padded = Buffer.concat([buf, Buffer.alloc((16 - (buf.length % 16)) % 16)])
  const enc = Buffer.concat([c.update(padded), c.final()]).toString('base64')

  const got = decryptSecret(appId, enc)
  if (got !== secret) throw new Error(`decrypt round-trip failed: got "${got}"`)
  const h = openSign({ appId, body: '{"a":1}', encSecret: enc, method: 'POST' })
  if (!/^[0-9a-f]{32}$/.test(h[HDR.sign])) throw new Error(`sign not 32 hex: ${h[HDR.sign]}`)
  console.log('sign.js self-check OK')
}
