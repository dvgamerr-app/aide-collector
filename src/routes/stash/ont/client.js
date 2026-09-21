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
    const q = new Map()
    if (!Bun.env.AG_PASS) return { names: this.names, q, status: 'disabled' }
    let status = 'backoff'
    if (Date.now() >= this.statsDue) {
      try {
        const stats = await this.get('/control/stats')
        if (!Array.isArray(stats.top_clients)) throw new Error('Invalid AdGuard stats')
        for (const client of stats.top_clients) for (const [ip, count] of Object.entries(client)) q.set(ip, count)
        this.failures = 0
        // The collection endpoint already enforces the minimum interval.
        this.statsDue = 0
        status = 'ok'
      } catch (error) {
        q.clear()
        status = 'unavailable'
        this.statsDue = Date.now() + Math.min(900000, pollInterval() * 2 ** Math.min(++this.failures, 10))
        logger.warn({ error: error.message }, 'ONT AdGuard stats unavailable')
      }
    }
    if (Date.now() >= this.namesDue) {
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
        this.namesDue = Date.now() + Math.min(900000, pollInterval() * 2 ** Math.min(++this.nameFailures, 10))
        logger.warn({ error: error.message }, 'ONT AdGuard names unavailable')
      }
    }
    return { names: this.names, q, status }
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
    if (browser) await browser.close()
  }

  async open() {
    if (!Bun.env.ONT_PASS) throw new Error('ONT_PASS is required')
    const executablePath =
      Bun.env.CHROME_PATH ||
      (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/chromium')
    this.browser = await chromium.launch({ executablePath, handleSIGINT: false, handleSIGTERM: false, headless: true, timeout: timeout() })
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

  async read() {
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
      if (
        !Array.isArray(result?.data) ||
        result.data.some(
          (host) => !host || !/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(host.MACAddress) || !['0', 0, '1', 1].includes(host.Active),
        )
      )
        throw new Error('Invalid ONT host response; no snapshot saved')
      return [...new Map(result.data.map((host) => [host.MACAddress.toUpperCase(), host])).values()]
    } catch (error) {
      await this.close()
      throw error
    }
  }
}
