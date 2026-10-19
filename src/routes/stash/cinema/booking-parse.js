import { collapse, MAJOR_ORIGIN, slugify, textSink } from './normalize'

// Vista marks a bookable seat with status 0; anything else is sold, held, broken or a house seat.
const SEAT_AVAILABLE = 0

export const parseTheaters = async (html) => {
  const theaters = []
  let region = ''
  let zone = ''

  await new HTMLRewriter()
    .on('div[data-id-bkk], div[data-id-central], div[data-id-north], div[data-id-west], div[data-id-northeast], div[data-id-south]', {
      element(element) {
        for (const [name] of element.attributes) {
          if (name.startsWith('data-id-')) region = name.slice('data-id-'.length)
        }
      },
    })
    .on(
      'div.zone_name h3',
      textSink((value) => {
        zone = value
      }),
    )
    .on('div.cinema_div_list a.bcbl-branches', {
      element(element) {
        const id = element.getAttribute('data-cinema-id')
        const name = collapse(element.getAttribute('data-branch-title'))
        if (id && name) theaters.push({ id, name, region, slug: slugify(name), zone })
      },
    })
    .transform(new Response(html))
    .arrayBuffer()

  return [...new Map(theaters.map((theater) => [theater.id, theater])).values()]
}

export const parseShowtimes = async (html) => {
  const showtimes = []
  let movie = null
  let hall = null
  let hallLine = 0

  await new HTMLRewriter()
    .on('div.bscbb-movie', {
      element(element) {
        movie = { bind: '', genre: '', minutes: '', title: '', url: '' }
        element.onEndTag(() => {
          movie = null
        })
      },
    })
    .on(
      'div.bscbbm-cover-title',
      textSink((value) => {
        if (movie) movie.title = value
      }),
    )
    .on(
      'div.bscbbm-cover-cate',
      textSink((value) => {
        if (movie) movie.genre = value.replace(/\s*\/\s*$/, '')
      }),
    )
    .on(
      'div.bscbbm-cover-time',
      textSink((value) => {
        if (movie) movie.minutes = value
      }),
    )
    .on('div.bscbbm-cover-see-detail a', {
      element(element) {
        if (!movie) return
        const path = element.getAttribute('href') || ''
        movie.bind = slugify(path.replace(/^\/movie\//, ''))
        movie.url = path.startsWith('http') ? path : `${MAJOR_ORIGIN}${path}`
      },
    })
    .on('div.bscbbm-theatre-list', {
      element(element) {
        hall = { audio: '', name: '' }
        hallLine = 0
        element.onEndTag(() => {
          hall = null
        })
      },
    })
    // The hall block lists the screen name first and the audio/subtitle track second.
    .on(
      'div.bscbbm-theatre-list-name ul.bscbbmt li',
      textSink((value) => {
        if (!hall) return
        if (hallLine === 0) hall.name = value
        else if (hallLine === 1 && value) hall.audio = value
        hallLine += 1
      }),
    )
    .on('div.bscbbm-theatre-list-time a', {
      element(element) {
        const showtime = element.getAttribute('data-showtime')
        const classes = element.getAttribute('class') || ''
        if (!showtime) {
          // A past screening renders as a plain 'pasted' label without a booking id.
          if (classes.includes('pasted')) showtimes.push({ hall: { ...hall }, movie: { ...movie }, past: true, showtime: null, time: '' })
          return
        }
        showtimes.push({ hall: { ...hall }, movie: { ...movie }, past: false, showtime, time: '' })
      },
    })
    .on(
      'div.bscbbm-theatre-list-time a',
      textSink((value) => {
        const last = showtimes.at(-1)
        if (last && !last.time) last.time = value
      }),
    )
    .transform(new Response(html))
    .arrayBuffer()

  return showtimes.filter((entry) => entry.time)
}

/** The seat plan arrives as a JSON blob embedded in the booking fragment, not as rendered markup. */
export const parseSeatPlan = (html) => {
  const match = /seat_data_string\s*=\s*'([\s\S]*?)'\s*;/.exec(html)
  if (!match) return null

  let payload
  try {
    payload = JSON.parse(match[1])
  } catch {
    return null
  }

  const rows = []
  let available = 0
  let total = 0

  for (const row of payload?.result?.seats || []) {
    const seats = []
    for (const column of row.Columns || []) {
      if (column?.Id === undefined) continue
      const free = column.Status === SEAT_AVAILABLE
      seats.push({ available: free, column: column.Position?.ColumnIndex ?? null, id: column.Id, type: column.AreaCategoryCode })
      total += 1
      if (free) available += 1
    }
    if (seats.length) rows.push({ available: seats.filter((seat) => seat.available).length, name: row.Name, seats, total: seats.length })
  }

  return { available, occupied: total - available, rows, tickets: parseTickets(payload?.result?.tickets), total }
}

const parseTickets = (tickets) => {
  const seen = new Map()
  for (const group of tickets || []) {
    for (const ticket of Object.values(group || {})) {
      if (ticket?.TicketCode && !seen.has(ticket.TicketCode)) {
        seen.set(ticket.TicketCode, { code: ticket.TicketCode, name: ticket.Ticket, price: ticket.Price, seatType: ticket.SeatType })
      }
    }
  }
  return [...seen.values()]
}
