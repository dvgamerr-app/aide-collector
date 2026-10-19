import { chromium } from 'playwright-core'

const seconds = (name, fallback, minimum = 1) => {
  const value = Number(Bun.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < minimum || value > 86400) throw new Error(`${name} must be ${minimum}..86400 seconds`)
  return value * 1000
}

export const sourceId = () => Bun.env.ONT_ID || 'main'
export const ontBase = () => new URL(Bun.env.ONT_BASE || 'http://10.203.1.1').origin
export const pollInterval = () => seconds('ONT_MIN_INTERVAL', 60, 60)
const timeout = () => seconds('ONT_REQUEST_TIMEOUT', 15)

/** Exponential backoff from the poll interval, capped at 15 minutes. */
export const backoff = (failures) => Math.min(900000, pollInterval() * 2 ** Math.min(failures, 10))

const bounded = async (promise, milliseconds) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ONT request timed out')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const MAC_ADDRESS = /^([\da-f]{2}:){5}[\da-f]{2}$/i

const rejectHost = (host) => {
  if (!host || typeof host !== 'object') return { reason: 'not an object' }
  if (typeof host.MACAddress !== 'string' || !MAC_ADDRESS.test(host.MACAddress))
    return { mac_length: String(host.MACAddress ?? '').length, reason: 'bad MACAddress' }
  if (!['0', 0, '1', 1].includes(host.Active)) return { active: host.Active, reason: 'bad Active' }
  return null
}

/** Drop malformed rows instead of discarding the whole snapshot; fail only when nothing usable remains. */
export const validHosts = (data, logger) => {
  const valid = []
  const rejected = []
  data.forEach((host, index) => {
    const reason = rejectHost(host)
    if (reason) rejected.push({ index, ...reason })
    else valid.push(host)
  })
  if (rejected.length)
    logger?.warn({ rejected: rejected.slice(0, 5), rejected_count: rejected.length, total: data.length }, 'ONT hosts skipped')
  if (!valid.length && data.length) throw new Error(`Invalid ONT host response: all ${data.length} hosts rejected`)
  return [...new Map(valid.map((host) => [host.MACAddress.toUpperCase(), host])).values()]
}

export class AdGuard {
  failures = 0
  nameFailures = 0
  names = new Map()
  namesDue = 0
  statsDue = 0

  async get(path) {
    const auth = Buffer.from(`${Bun.env.AG_USER || 'dvgamerr'}:${Bun.env.AG_PASS}`).toString('base64')
    const response = await fetch(new URL(path, Bun.env.AG_BASE || 'http://10.203.1.91:8080'), {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeout()),
    })
    if (!response.ok) throw new Error(`AdGuard ${path}: HTTP ${response.status}`)
    return response.json()
  }

  async read(logger) {
    if (!Bun.env.AG_PASS) return { names: this.names, q: new Map(), status: 'disabled' }
    const { q, status } = Date.now() >= this.statsDue ? await this.readStats(logger) : { q: new Map(), status: 'backoff' }
    if (Date.now() >= this.namesDue) await this.readNames(logger)
    return { names: this.names, q, status }
  }

  async readNames(logger) {
    try {
      const clients = await this.get('/control/clients')
      if (!Array.isArray(clients.auto_clients) && !Array.isArray(clients.clients)) throw new Error('Invalid AdGuard clients')
      const names = new Map()
      for (const client of clients.auto_clients || []) if (client.ip && client.name) names.set(client.ip, client.name)
      for (const client of clients.clients || []) for (const id of client.ids || []) if (client.name) names.set(id, client.name)
      this.names = names
      this.nameFailures = 0
      this.namesDue = Date.now() + seconds('AG_CLIENT_INTERVAL', 900, 60)
    } catch (error) {
      this.namesDue = Date.now() + backoff(++this.nameFailures)
      logger.warn({ error: error.message }, 'ONT AdGuard names unavailable')
    }
  }

  async readStats(logger) {
    try {
      const stats = await this.get('/control/stats')
      if (!Array.isArray(stats.top_clients)) throw new Error('Invalid AdGuard stats')
      const q = new Map(stats.top_clients.flatMap((client) => Object.entries(client)))
      this.failures = 0
      // The collection endpoint already enforces the minimum interval.
      this.statsDue = 0
      return { q, status: 'ok' }
    } catch (error) {
      this.statsDue = Date.now() + backoff(++this.failures)
      logger.warn({ error: error.message }, 'ONT AdGuard stats unavailable')
      return { q: new Map(), status: 'unavailable' }
    }
  }
}

export class OntSession {
  browser = null
  page = null
  requests = 0

  async close() {
    const browser = this.browser
    this.page = null
    this.browser = null
    // A browser that will not close must not stall the next attempt or replace the error that got us here.
    if (browser) await bounded(browser.close(), timeout()).catch(() => {})
  }

  async open() {
    if (!Bun.env.ONT_PASS) throw new Error('ONT_PASS is required')
    const executablePath =
      Bun.env.CHROME_PATH ||
      (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/chromium')
    this.browser = await chromium.launch({
      // /dev/shm is tiny in a container, which makes Chromium hang instead of failing; the crash reporter is a
      // helper process nobody reads and the one that shows up as a zombie.
      args: ['--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad'],
      executablePath,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: true,
      timeout: timeout(),
    })
    this.page = await this.browser.newPage()
    this.page.setDefaultTimeout(timeout())
    await this.page.route('**/*', (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== ontBase()) return route.abort()
      // Keep firmware crypto, but never mount its dashboard/background polling.
      if (url.pathname === '/src/main.js' || url.pathname === '/src/index.js')
        return route.fulfill({ body: '', contentType: 'application/javascript' })
      if (['font', 'image', 'stylesheet'].includes(request.resourceType())) return route.abort()
      return route.continue()
    })
    this.page.on('request', (request) => {
      if (['fetch', 'xhr'].includes(request.resourceType())) this.requests++
    })
    await this.page.goto(`${ontBase()}/login_ais.html?1`, { waitUntil: 'domcontentloaded' })
    await this.page.waitForFunction(() => typeof window.onLogin === 'function' && document.getElementById('loginpp'))
    await this.page.evaluate(
      ({ pass, user }) => {
        document.getElementById('user_name').value = user
        document.getElementById('loginpp').value = pass
        // Firmware globals live in the browser context.
        /* global zkzcode, onLogin, initPageConfigure, $post */
        if (document.getElementById('validate_code') && typeof zkzcode !== 'undefined')
          document.getElementById('validate_code').value = zkzcode
        onLogin(1)
      },
      { pass: Bun.env.ONT_PASS, user: Bun.env.ONT_USER || 'admin' },
    )
    await this.page.waitForURL((url) => url.pathname === '/main.html')
    await this.page.waitForFunction(() => typeof initPageConfigure === 'function' && typeof $post === 'function')
    await bounded(
      this.page.evaluate(() => initPageConfigure()),
      timeout(),
    )
  }

  async read(logger) {
    try {
      if (!this.page) await this.open()
      const result = await bounded(
        this.page.evaluate(() =>
          $post('get_xml_childnode_value', {
            node: {
              Active: 'Active',
              AddressSource: 'AddressSource',
              DeviceType: 'DeviceType',
              DevName: 'DevName',
              ExInterface: 'X_FH_ExInterface',
              HostName: 'HostName',
              IPAddress: 'IPAddress',
              Layer2Interface: 'Layer2Interface',
              LeaseTimeRemaining: 'LeaseTimeRemaining',
              LinkType: 'X_FH_LinkType',
              MACAddress: 'MACAddress',
              OnlineTime: 'OnlineTime',
              rssi: 'X_FH_RSSI',
              rx_rate: 'NegoRxRate',
              tx_rate: 'NegoTxRate',
            },
            url: 'LANDevice.1.Hosts.Host.',
          }),
        ),
        timeout(),
      )
      if (!Array.isArray(result?.data))
        throw new Error(`Invalid ONT host response: data is ${result?.data === null ? 'null' : typeof result?.data}`)
      return validHosts(result.data, logger)
    } catch (error) {
      await this.close()
      throw error
    }
  }
}
