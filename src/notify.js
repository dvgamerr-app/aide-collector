import { userAgent } from './config'

const BASE = Bun.env.NOTIFY_BASE || 'https://notice.dvgamerr.app'

export class NotifyError extends Error {}

/** Push up to 5 LINE message objects to a chat registered on a notice-manager bot. */
export const sendNotify = async (bot, chat, messages) => {
  const apiKey = Bun.env.NOTIFY_API_KEY
  if (!apiKey) throw new NotifyError('NOTIFY_API_KEY is required')
  if (!chat) throw new NotifyError('chat id is required')

  const res = await fetch(`${BASE}/v1/bots/${bot}/chats/${chat}/messages`, {
    body: JSON.stringify({ messages }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent, 'X-API-Key': apiKey },
    method: 'POST',
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) throw new NotifyError(body?.error || `notify failed: HTTP ${res.status}`)
  return body
}
