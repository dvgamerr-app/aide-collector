# Cinema collector

รวม logic ของ `etl-cinema-scraper` เดิมเข้ามาใน service นี้ ไม่ต้องรัน scraper แยกและไม่ต้องใช้ Puppeteer/Chromium อีกต่อไป

## โมดูล

| ไฟล์                                   | หน้าที่                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `src/routes/stash/cinema/index.js`     | route handler ของ `PATCH /stash/cinema` และ `POST /stash/cinema`        |
| `src/routes/stash/cinema/major.js`     | ดึงและ parse หน้า Major Cineplex ทั้งภาษาไทยและอังกฤษ                   |
| `src/routes/stash/cinema/sf.js`        | ดึงและ parse SF Cinema พร้อมตรวจจับ Cloudflare challenge                |
| `src/routes/stash/cinema/normalize.js` | slug/วันฉาย/ความยาว/สัปดาห์ และการรวมหนังเรื่องเดียวกันจากหลายโรง       |
| `src/routes/stash/cinema/request.js`   | fetch ที่มี browser header, timeout, retry และ bounded-concurrency pool |
| `src/routes/stash/cinema/storage.js`   | multi-row upsert และ de-duplicate แบบ set-based                         |

## แหล่งข้อมูล

### Major Cineplex

`https://www.majorcineplex.com/movie/` เป็น server-rendered HTML จึงใช้ `fetch` + `HTMLRewriter` ได้โดยตรง

ภาษาเก็บไว้ใน session (`GET /home/set_session/{lang}` แล้วอ่านคุกกี้ `connect.sid`) โค้ดจึงเปิด session แยกสองชุดและดึงหน้าไทย/อังกฤษ **พร้อมกัน** จับคู่ด้วย path ของหนัง

ข้อมูลที่ใช้ต่อการ์ดหนึ่งใบ

- `div.mlb-name a` — ชื่อและ path (ใช้ทำ `s_bind`)
- `div.mlb-date` — วันฉาย
- `div.mlbc-cate` — genre แบบเต็ม เช่น `Action / Animation / Drama` (`span.genres_span` ให้แค่ genre แรก จึงใช้เป็น fallback)
- `div.mlbc-time` — ความยาว เช่น `01 HR. 35 MINS` / `01 ชม. 35 นาที`
- `div.mlb-cover` — cover จาก inline `background:url(...)`
- panel `#movie-page-showing` / `#movie-page-coming` — ใช้กำหนด `s_section`

### SF Cinema

โดเมนย้ายจาก `sfcinemacity.com` ไป `sfcinema.com` และปัจจุบัน**ทั้งไซต์อยู่หลัง Cloudflare interactive challenge** — ตอบ `403` แม้แต่ `robots.txt` ทั้งกับ `fetch` และ headless browser

collector จึงตรวจจับ challenge แล้วรายงานเป็น source ที่ใช้ไม่ได้ (log ระดับ `warn`) โดย **ไม่ทำให้ทั้ง job ล้ม** ข้อมูลของ Major ยังถูกบันทึกตามปกติ

parser ของ SF ยังคงอยู่ในโค้ดและจะกลับมาทำงานทันทีที่เข้าถึงไซต์ได้อีกครั้ง (เช่น ผ่าน egress ที่ไม่โดน challenge)

## Week bucket

`n_week`/`n_year` คือสัปดาห์ที่ **เก็บข้อมูล** ตามเวลา `Asia/Bangkok` ไม่ใช่สัปดาห์ที่หนังเข้าฉาย

เดิมเก็บเป็นสัปดาห์ของวันฉาย ทำให้ `GET /collector/cinema` ที่ filter ด้วยสัปดาห์ปัจจุบันแทบไม่คืนข้อมูลเลย ตอนนี้ฝั่งอ่านและฝั่งเขียนใช้ helper `cinemaWeek()` ตัวเดียวกัน

หนึ่งสัปดาห์จะได้ประมาณ 160 แถว รันซ้ำในสัปดาห์เดิมเป็น upsert ไม่เพิ่มแถวใหม่

## การรวมข้อมูลซ้ำ

1. **ในหน่วยความจำ** — `mergeCinemaEntries` เดินข้อมูลรอบเดียวด้วย alias index (`s_bind`, slug ของชื่อ EN/TH/display) รวม `theater` ของหนังเรื่องเดียวกัน
2. **ในฐานข้อมูล** — `mergeCinemaDuplicates` รวมแถวที่ผูก slug ต่างกันแต่ชื่อเดียวกัน จำกัดขอบเขตเฉพาะ `(n_year, n_week)` ที่ batch นี้แตะ และทำเป็น statement เดียวต่อคอลัมน์ชื่อ

ทั้งสองขั้นอยู่ใน transaction เดียวกับ upsert

## Endpoints

```bash
curl -X PATCH http://localhost:3000/stash/cinema
# { "success": true, "merged": 160, "removed": 0, "stored": 160, "sources": { "major": { "movies": 189, "ok": true }, "sf": { "error": "sf listing blocked: HTTP 403", "ok": false } } }

curl -X POST http://localhost:3000/stash/cinema -H 'content-type: application/json' -d '[...]'
```

`POST` ยังรับ payload รูปแบบเดิมของ `etl-cinema-scraper` (`name`, `name_en`, `name_th`, `timeMin`, `theater`) เพื่อความเข้ากันได้ย้อนหลัง

## Live showtime & seat API

อ่านสดจาก Major ทุกครั้งที่เรียก **ไม่บันทึกลงฐานข้อมูล** (มีแค่ cache รายชื่อสาขาใน memory 24 ชั่วโมง)

| Endpoint                                        | ตอบคำถาม                                   |
| ----------------------------------------------- | ------------------------------------------ |
| `GET /collector/cinema/theater`                 | มีสาขาอะไรบ้าง / หา id ของสาขา             |
| `GET /collector/cinema/showtime`                | สาขานี้วันนี้มีรอบไหน โรงไหน ว่างกี่ที่    |
| `GET /collector/cinema/showtime/:showtime/seat` | รอบนี้ผังที่นั่งเป็นยังไง ราคาตั๋วเท่าไหร่ |
| `GET /collector/cinema/:movie/:theater`         | หนังเรื่องนี้ที่สาขานี้ฉายรอบไหนบ้าง       |

### Query parameters

`showtime` และ `:movie/:theater` ใช้ query ชุดเดียวกัน

**ต้องระบุช่วงเวลาเสมอ** — ใส่ `time` หรือใส่ `from` คู่กับ `to` และ `date` เลือกได้แค่วันนี้หรือพรุ่งนี้ ทั้งสองข้อกันไม่ให้คำถามกว้างเกินจำเป็นและกัน load ที่ส่งไปหา Major

| Parameter | ค่าเริ่มต้น      | รายละเอียด                                                           |
| --------- | ---------------- | -------------------------------------------------------------------- |
| `theater` | —                | id, slug หรือบางส่วนของชื่อสาขา ไทย/อังกฤษ (บังคับสำหรับ `showtime`) |
| `date`    | วันนี้ (Bangkok) | `YYYY-MM-DD` รับเฉพาะวันนี้หรือพรุ่งนี้                              |
| `movie`   | ทั้งหมด          | slug หรือบางส่วนของชื่อหนัง ไทย/อังกฤษ                               |
| `time`    | —                | เวลาเริ่มพอดี `HH:MM` (ใช้แทน `from`/`to`)                           |
| `from`    | —                | เวลาเริ่มตั้งแต่ `HH:MM` **ต้องมีคู่กับ `to`** ถ้าไม่ได้ใส่ `time`   |
| `to`      | —                | เวลาเริ่มไม่เกิน `HH:MM` **ต้องมีคู่กับ `from`** ถ้าไม่ได้ใส่ `time` |
| `seats`   | `false`          | `true` เพื่อดึงจำนวนที่นั่งว่างของแต่ละรอบ (สูงสุด 10 รอบต่อครั้ง)   |
| `detail`  | `false`          | `true` เพื่อแนบผังที่นั่งรายแถว                                      |
| `past`    | `false`          | `true` เพื่อรวมรอบที่ฉายไปแล้ว (รอบเหล่านี้ไม่มี `showtime` id)      |

### ตัวอย่าง

```bash
# โรงหนังสาขาไหนบ้างที่ชื่อมี paragon
curl 'http://localhost:3000/collector/cinema/theater?search=paragon'

# พารากอน บ่าย 3 ถึง 4 โมงครึ่ง มีโรงไหน ว่างกี่ที่นั่ง
curl 'http://localhost:3000/collector/cinema/showtime?theater=paragon&from=15:00&to=16:30&seats=true'

# หนัง The Odyssey ที่พารากอน เย็นนี้ฉายรอบไหนบ้าง พร้อมที่ว่าง
curl 'http://localhost:3000/collector/cinema/the-odyssey/paragon?from=17:00&to=21:00&seats=true'

# ผังที่นั่งของรอบเดียว
curl 'http://localhost:3000/collector/cinema/showtime/6306778/seat?detail=true'
```

ตัวอย่างผลลัพธ์ของ `showtime` เมื่อใส่ `seats=true`

```json
{
  "success": true,
  "date": "2026-09-18",
  "theater": { "id": "1", "name": "Paragon Cineplex", "nameTh": "พารากอน ซีนีเพล็กซ์", "zone": "Bangkok: Urban" },
  "total": 6,
  "seatsAvailable": 1284,
  "showtimes": [
    {
      "time": "15:00",
      "past": false,
      "showtime": "6306776",
      "hall": { "name": "Theatre 6", "nameTh": "โรง 6", "audio": "EN/TH" },
      "movie": { "bind": "practical-magic-2", "title": "Practical Magic 2", "titleTh": "สองสาวพลังรัก เมจิกมนตราเสน่หา" },
      "seats": { "available": 208, "occupied": 8, "total": 216, "tickets": [{ "code": "0032", "name": "Normal(O)", "price": 280 }] }
    }
  ]
}
```

### แหล่งข้อมูลที่ใช้

| Endpoint ของ Major                   | ใช้ทำอะไร                                                     |
| ------------------------------------ | ------------------------------------------------------------- |
| `GET /home/cinema_bar/all`           | รายชื่อสาขาพร้อม `data-cinema-id`, zone และภูมิภาค            |
| `POST /booking2/get_showtime/`       | รอบฉายของสาขาในวันที่ระบุ (ต้องมี trailing slash ไม่งั้น 308) |
| `GET /booking2/get_seat/{showtime}/` | ผังที่นั่ง — JSON ฝังอยู่ในตัวแปร `seat_data_string`          |

ทุก endpoint ดึงทั้งภาษาไทยและอังกฤษขนานกัน (คนละ session cookie) แล้วจับคู่ด้วย branch id / showtime id จึงค้นด้วยชื่อภาษาไหนก็ได้

ที่นั่งนับจาก `Status` ของ Vista: `0` คือว่างจองได้ ค่าอื่นคือขายแล้ว/ถูกกันไว้/เสีย

ผังที่นั่งดึงทีละ request (ไม่ยิงขนาน) และจำกัด 10 รอบต่อคำขอ เพื่อไม่ให้สร้าง load กับ Major — เกินนั้นจะตอบ `seatsTruncated` มาด้วย
