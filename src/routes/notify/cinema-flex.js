import dayjs from 'dayjs'
import buddhistEra from 'dayjs/plugin/buddhistEra'
import 'dayjs/locale/th'

dayjs.extend(buddhistEra)

// LINE caps a carousel at 12 bubbles; stay well under it so a card never gets silently dropped.
const BUBBLE_LIMIT = 10

const THEATER_BADGE = {
  major: { color: '#dc3545cc', label: 'Major', width: 55 },
  sf: { color: '#2f67cdcc', label: 'SF Cinema', width: 70 },
}

const theaterBadges = (theaters) => {
  let offset = 10
  const badges = []

  for (const key of ['sf', 'major']) {
    if (!theaters?.includes(key)) continue
    const meta = THEATER_BADGE[key]
    badges.push({
      backgroundColor: meta.color,
      contents: [{ align: 'center', color: '#ffffff', gravity: 'center', size: 'xxs', text: meta.label, type: 'text' }],
      cornerRadius: '5px',
      flex: 0,
      height: '25px',
      layout: 'horizontal',
      offsetEnd: `${offset}px`,
      offsetTop: '10px',
      paddingAll: '2px',
      paddingEnd: '4px',
      paddingStart: '4px',
      position: 'absolute',
      type: 'box',
      width: `${meta.width}px`,
    })
    offset += meta.width + 10
  }

  return badges
}

const releaseLabel = (release) => (release ? dayjs(release).locale('th').format('DD MMMM BBBB') : 'เร็วๆ นี้')

const bubble = (movie) => ({
  body: {
    contents: [
      {
        contents: [
          { aspectMode: 'cover', aspectRatio: '120:190', flex: 1, gravity: 'center', size: 'full', type: 'image', url: movie.s_cover },
          ...theaterBadges(movie.o_theater),
        ],
        cornerRadius: '0px',
        layout: 'vertical',
        paddingAll: '0px',
        type: 'box',
      },
      {
        action: {
          label: 'trailer',
          type: 'uri',
          uri: encodeURI(`https://www.youtube.com/results?search_query=${movie.s_display.replace(/\W/gi, '+')}+trailer`),
        },
        backgroundColor: '#464F69cc',
        contents: [
          { color: '#ffffff', size: 'sm', text: movie.s_display, type: 'text', weight: 'bold', wrap: true },
          { color: '#ffffffcc', size: 'xxs', text: releaseLabel(movie.t_release), type: 'text' },
          ...(movie.n_time
            ? [
                {
                  color: '#ffffff',
                  offsetEnd: '10px',
                  offsetTop: '29px',
                  position: 'absolute',
                  size: 'xxs',
                  text: `${movie.n_time} นาที`,
                  type: 'text',
                },
              ]
            : []),
        ],
        layout: 'vertical',
        offsetBottom: '0px',
        paddingBottom: '10px',
        paddingEnd: '10px',
        paddingStart: '20px',
        paddingTop: '10px',
        position: 'absolute',
        type: 'box',
        width: '100%',
      },
    ],
    cornerRadius: '0px',
    layout: 'vertical',
    paddingAll: '0px',
    type: 'box',
  },
  size: 'kilo',
  type: 'bubble',
})

/** Splits now-showing movies into one or more LINE flex carousel messages, capped at BUBBLE_LIMIT bubbles each. */
export const buildCinemaFlex = (movies, altText) => {
  const chunks = []
  for (let index = 0; index < movies.length; index += BUBBLE_LIMIT) chunks.push(movies.slice(index, index + BUBBLE_LIMIT))

  return chunks.map((chunk, index) => ({
    altText: chunks.length > 1 ? `${altText} [${index + 1}/${chunks.length}]` : altText,
    contents: { contents: chunk.map(bubble), type: 'carousel' },
    type: 'flex',
  }))
}
