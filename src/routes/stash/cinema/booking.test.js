import { describe, expect, it } from 'bun:test'

import { matchTheater, parseSeatPlan, parseShowtimes, parseTheaters } from './booking'
import { allowedDates, matchesMovie, readQuery, withinWindow } from './routes'

const BRANCH_HTML = `
<div class="bqbl-list-cinema">
  <div class="cinema_tab_bangkok" data-id-bkk="13">
    <div class="zone_name"><h3>
        Bangkok: Urban
    </h3></div>
    <div class="bcb-list cinema_div_list" data-cinema-key="1">
      <a href="javascript:;" data-cinema-id="1" data-branch-title="Paragon Cineplex" class="bcbl-branches">Paragon Cineplex</a>
    </div>
    <div class="bcb-list cinema_div_list" data-cinema-key="12">
      <a href="javascript:;" data-cinema-id="12" data-branch-title="Major Rangsit" class="bcbl-branches">Major Rangsit</a>
    </div>
  </div>
  <div class="cinema_tab_north" data-id-north="4">
    <div class="zone_name"><h3>Chiangmai</h3></div>
    <div class="bcb-list cinema_div_list" data-cinema-key="30">
      <a href="javascript:;" data-cinema-id="30" data-branch-title="Major Chiangmai" class="bcbl-branches">Major Chiangmai</a>
    </div>
  </div>
</div>`

const SHOWTIME_HTML = `
<div class="box-showtime-cinema"><div class="bsc-list"><div class="accordion" id="Branch_List">
  <div class="bsc-branch"><div class="collapse show"><div class="bscb-body">
    <div class="bscbb-movie">
      <div class="bscbbm-cover"><div class="bscbbm-cover-name">
        <div class="bscbbm-cover-title">
            The Odyssey
        </div>
        <div class="bscbbm-cover-cate-time">
          <div class="bscbbm-cover-cate"><img class="icon-cate-time">
              Action/
              Adventure/
          </div>
          <div class="bscbbm-cover-time"><img class="icon-cate-time">
            173
            mins</div>
        </div>
        <div class="bscbbm-cover-see-detail"><a href="/movie/the-odyssey" target="_blank">detail</a></div>
      </div></div>
      <div class="bscbbm-theatre bscbbm-movie">
        <div class="bscbbm-theatre-list bscbbmtl-movie first_bsc">
          <div class="bscbbm-theatre-list-name">
            <ul class="bscbbmt bscbbmt-movie">
              <li>Vietjet VIP Cinema 1</li>
              <li style="cursor:pointer"><img class="icon-sound">
                EN/TH
              </li>
              <li><img class="icon-rate"></li>
            </ul>
          </div>
          <div class="bscbbm-theatre-list-time">
            <a href="javascript:;" class="pasted">12:30</a>
            <a href="javascript:;" class="nowst nextst " data-only-cinema="1" data-only-movie="3391" data-showtime="6306778">
              16:00
            </a>
            <a href="javascript:;" class="nextst " data-only-cinema="1" data-only-movie="3391" data-showtime="6306788">
              19:30
            </a>
          </div>
        </div>
      </div>
    </div>
  </div></div></div>
</div></div></div>`

const seatPlanHtml = (result) => `<div class="plan"></div><script>
    var e = '6306778';
    var seat_type_string = '{"Normal":"chair.png"}';
    var seat_data_string = '${JSON.stringify({ cache: true, result, status: 200 })}';
    var data = JSON.parse(seat_data_string);
</script>`

const seat = (id, status) => ({
  AreaCategoryCode: '0000000006',
  Id: String(id),
  Position: { AreaNumber: 1, ColumnIndex: id, RowIndex: 1 },
  Status: status,
})

describe('Major branch list parser', () => {
  it('reads every branch with its zone and region', async () => {
    const theaters = await parseTheaters(BRANCH_HTML)

    expect(theaters).toEqual([
      { id: '1', name: 'Paragon Cineplex', region: 'bkk', slug: 'paragon-cineplex', zone: 'Bangkok: Urban' },
      { id: '12', name: 'Major Rangsit', region: 'bkk', slug: 'major-rangsit', zone: 'Bangkok: Urban' },
      { id: '30', name: 'Major Chiangmai', region: 'north', slug: 'major-chiangmai', zone: 'Chiangmai' },
    ])
  })
})

describe('Major branch matching', () => {
  const theaters = [
    { id: '1', name: 'Paragon Cineplex', nameTh: 'พารากอน ซีนีเพล็กซ์', slug: 'paragon-cineplex', slugTh: 'พารากอน-ซีนีเพล็กซ์' },
    {
      id: '217',
      name: 'Coca Cola IMAX Mega Bangna',
      nameTh: 'โคคา โคล่า ไอแมกซ์ เมกาบางนา',
      slug: 'coca-cola-imax-mega-bangna',
      slugTh: 'โคคา-โคล่า-ไอแมกซ์-เมกาบางนา',
    },
  ]

  it('matches by id, slug and partial name in either language', () => {
    expect(matchTheater(theaters, '217')?.id).toBe('217')
    expect(matchTheater(theaters, 'paragon-cineplex')?.id).toBe('1')
    expect(matchTheater(theaters, 'paragon')?.id).toBe('1')
    expect(matchTheater(theaters, 'พารากอน')?.id).toBe('1')
  })

  it('ignores the separators branch names are written with inconsistently', () => {
    expect(matchTheater(theaters, 'เมกา บางนา')?.id).toBe('217')
  })

  it('prefers the closest branch regardless of the order Major returns them in', () => {
    const imaxFirst = [
      {
        id: '38',
        name: 'IMAX LASER Paragon Cineplex',
        nameTh: 'ไอแมกซ์ เลเซอร์ พารากอน ซีนีเพล็กซ์',
        slug: 'imax-laser-paragon-cineplex',
        slugTh: 'ไอแมกซ์-เลเซอร์-พารากอน-ซีนีเพล็กซ์',
      },
      ...theaters,
    ]

    expect(matchTheater(imaxFirst, 'พารากอน')?.id).toBe('1')
    expect(matchTheater(imaxFirst, 'paragon')?.id).toBe('1')
    expect(matchTheater(imaxFirst, 'imax')?.id).toBe('38')
    expect(matchTheater(imaxFirst, 'imax paragon')?.id).toBe('38')
  })

  it('returns null instead of the first branch for an unmatchable reference', () => {
    expect(matchTheater(theaters, 'ไม่มีสาขานี้เลย')).toBeNull()
    expect(matchTheater(theaters, '999')).toBeNull()
    // '***' slugifies to an empty string, which every branch name would 'contain'.
    expect(matchTheater(theaters, '***')).toBeNull()
    expect(matchTheater(theaters, '')).toBeNull()
  })
})

describe('Major showtime parser', () => {
  it('reads each screening with its hall, movie and booking id', async () => {
    const showtimes = await parseShowtimes(SHOWTIME_HTML)

    expect(showtimes).toHaveLength(3)
    expect(showtimes[1]).toEqual({
      hall: { audio: 'EN/TH', name: 'Vietjet VIP Cinema 1' },
      movie: {
        bind: 'the-odyssey',
        genre: 'Action/ Adventure',
        minutes: '173 mins',
        title: 'The Odyssey',
        url: 'https://www.majorcineplex.com/movie/the-odyssey',
      },
      past: false,
      showtime: '6306778',
      time: '16:00',
    })
  })

  it('keeps a screening that already started but leaves it without a booking id', async () => {
    const [first] = await parseShowtimes(SHOWTIME_HTML)
    expect(first).toMatchObject({ past: true, showtime: null, time: '12:30' })
  })
})

describe('Major seat plan parser', () => {
  it('counts free seats and skips the gaps between them', () => {
    const html = seatPlanHtml({
      seats: [
        { Columns: [[], [], []], Name: '' },
        { Columns: [seat(1, 0), [], seat(2, 1), seat(3, 0)], Name: 'A' },
      ],
      tickets: [{ 6: { AreaCategoryCode: '0000000006', Price: 280, SeatType: 'Normal(O)', Ticket: 'Normal(O)', TicketCode: '0032' } }],
    })

    expect(parseSeatPlan(html)).toMatchObject({
      available: 2,
      occupied: 1,
      rows: [{ available: 2, name: 'A', total: 3 }],
      tickets: [{ code: '0032', name: 'Normal(O)', price: 280 }],
      total: 3,
    })
  })

  it('returns null when the fragment carries no seat payload', () => {
    expect(parseSeatPlan('<div>Box office only</div>')).toBeNull()
    expect(parseSeatPlan("<script>var seat_data_string = '{oops';</script>")).toBeNull()
  })
})

describe('showtime filters', () => {
  const entry = { movie: { bind: 'the-odyssey', title: 'The Odyssey', titleTh: 'มหากาพย์โอดิสซี' }, time: '16:00' }

  it('matches a movie by slug or by part of either title', () => {
    expect(matchesMovie(entry, 'the-odyssey')).toBe(true)
    expect(matchesMovie(entry, 'odyssey')).toBe(true)
    expect(matchesMovie(entry, 'โอดิสซี')).toBe(true)
    expect(matchesMovie(entry, 'spider-man')).toBe(false)
    expect(matchesMovie(entry, '')).toBe(true)
    expect(matchesMovie(entry, '***')).toBe(false)
  })

  it('keeps only the screenings inside the requested window', () => {
    expect(withinWindow({ time: '16:00' }, entry)).toBe(true)
    expect(withinWindow({ time: '15:00' }, entry)).toBe(false)
    expect(withinWindow({ from: '15:00', to: '16:30' }, entry)).toBe(true)
    expect(withinWindow({ from: '17:00' }, entry)).toBe(false)
    expect(withinWindow({ to: '15:00' }, entry)).toBe(false)
    expect(withinWindow({}, entry)).toBe(true)
  })
})

describe('showtime query validation', () => {
  const [today, tomorrow] = allowedDates()

  it('offers today and tomorrow only', () => {
    expect(allowedDates()).toHaveLength(2)
    expect(tomorrow > today).toBe(true)
  })

  it('accepts a window given as time or as from plus to', () => {
    expect(readQuery({ theater: 'paragon', time: '15:00' })).toMatchObject({ date: today, from: '', time: '15:00', to: '' })
    expect(readQuery({ date: tomorrow, from: '15:00', to: '18:00' })).toMatchObject({ date: tomorrow, from: '15:00', to: '18:00' })
  })

  it('rejects a query without a time window', () => {
    expect(readQuery({}).error).toMatch(/time window is required/)
    expect(readQuery({ from: '15:00' }).error).toMatch(/time window is required/)
    expect(readQuery({ to: '18:00' }).error).toMatch(/time window is required/)
  })

  it('rejects a window that runs backwards or is malformed', () => {
    expect(readQuery({ from: '18:00', to: '15:00' }).error).toBe('from must not be later than to')
    expect(readQuery({ from: '9:00', to: '18:00' }).error).toBe('from must be HH:MM')
    expect(readQuery({ time: '25:00' }).error).toBe('time must be HH:MM')
  })

  it('rejects a date further out than tomorrow', () => {
    expect(readQuery({ date: '2020-01-01', time: '15:00' }).error).toMatch(/date must be one of/)
    expect(readQuery({ date: '2099-01-01', time: '15:00' }).error).toMatch(/date must be one of/)
    expect(readQuery({ date: 'tomorrow', time: '15:00' }).error).toBe('date must be YYYY-MM-DD')
  })
})
