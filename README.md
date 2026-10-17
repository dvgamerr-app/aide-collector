# Aide Collector

REST API สำหรับรวบรวมและอ่านข้อมูล cinema, gold, lottery, MEA, MWA, solar, ONT และ reminder พร้อม endpoint สำหรับจัดการ API token สร้างด้วย Bun, Elysia, Kysely และ PostgreSQL

## เริ่มต้นใช้งาน

ต้องมี [Bun](https://bun.sh/) 1.3 ขึ้นไป และ PostgreSQL โดยสามารถเปิดฐานข้อมูลสำหรับ development ผ่าน Docker Compose ได้

```bash
docker compose up -d db
cp .env.example .env
bun install
bun run migration:run
bun run dev
```

แก้ `DATABASE_URL` และค่าของ collector ที่ต้องการใช้ใน `.env` ก่อนรัน migration เซิร์ฟเวอร์เปิดที่ `http://localhost:3000` โดยค่าเริ่มต้น และ Swagger UI อยู่ที่ `GET /docs`

> Migration ทำงานอัตโนมัติตอน boot (`migrate()` ใน `src/index.js`) ถ้า migration ล้มเหลว service จะไม่ start ส่วน `bun run migration:run` ยังใช้รันแยกได้ เช่นก่อน deploy หรือใน CI

## ตัวแปรสภาพแวดล้อม

| ตัวแปร                  | จำเป็น         | รายละเอียด                                                                                                                                                                                           |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | ใช่            | PostgreSQL connection string                                                                                                                                                                         |
| `PORT`                  | ไม่            | พอร์ตของ API ค่าเริ่มต้น `3000`                                                                                                                                                                      |
| `LOG_LEVEL`             | ไม่            | ระดับ log ของ Pino ค่าเริ่มต้น `info`                                                                                                                                                                |
| `DATABASE_WAKATIME_URL` | เฉพาะ WakaTime | PostgreSQL ของ WakaTime (อ่านอย่างเดียว) สำหรับ `/v1/coding`, `/v1/coding/days`, `/v1/telemetry`                                                                                                     |
| `GH_USER_TOKEN`         | เฉพาะ GitHub   | token อ่านอย่างเดียวของบัญชีผู้ใช้ (ชื่อเดิม `GH_TOKEN`) สำหรับ `PATCH /stash/github`                                                                                                                |
| `GH_APP_TOKEN`          | เฉพาะ GitHub   | token อ่านอย่างเดียวของ org `dvgamerr-app`, `dl-fansub`, `untirkx` (ไม่ตั้ง = ใช้ user token; ชื่อเดิม `GH_ORGS_TOKEN` ยังใช้ได้)                                                                    |
| `GH_OURKK_TOKEN`        | ไม่            | token อ่านอย่างเดียวของ org `ourkk`                                                                                                                                                                  |
| `GH_WORK_TOKEN`         | ไม่            | token อ่านอย่างเดียวของ org ที่ทำงาน `scg-wedo` (นับในยอดรวม แต่ไม่แสดงรายชื่อ repo)                                                                                                                 |
| `GH_AUTHOR_EMAIL`       | ไม่            | อีเมลผู้เขียน commit ที่ใช้คัดเฉพาะ repo ที่เคย commit ค่าเริ่มต้นคือ 4 อีเมลของเจ้าของ (`kananekt@scg.com`, `kem@ns.co.th`, `thkananek@central.co.th`, `info.dvgamer@gmail.com`) คั่นด้วย comma ได้ |
| `MEA_PAYLOAD`           | เฉพาะ MEA      | Base64 ของ JSON `{ "username", "password" }`                                                                                                                                                         |
| `MWA_PAYLOAD`           | เฉพาะ MWA      | Base64 ของ JSON `{ "userId", "password" }`; ดึงทุกบัญชีที่ลงทะเบียนไว้                                                                                                                               |
| `SOLAR_DEVICE_ID`       | เฉพาะ Solar    | device ID ที่จะรวบรวมข้อมูล                                                                                                                                                                          |
| `SOLAR_OPEN_APP_ID`     | เฉพาะ Solar    | App ID ของ Solar Open API                                                                                                                                                                            |
| `SOLAR_OPEN_APP_SECRET` | เฉพาะ Solar    | encrypted App Secret สำหรับลงลายเซ็น request                                                                                                                                                         |
| `SOLAR_PAYLOAD`         | เฉพาะ Solar    | Base64 ของ JSON `{ "account", "password" }` โดย password เป็น MD5 hex                                                                                                                                |

## คำสั่งหลัก

```bash
bun run dev             # development server พร้อม watch และ pretty logs
bun run start           # production-style server
bun run migration:run   # apply migrations ล่าสุด
bun run migration:down  # rollback migration ล่าสุดหนึ่งขั้น
bun run test            # unit tests
bun run lint            # ESLint แบบไม่แก้ไฟล์
bun run format          # ตรวจ Prettier แบบไม่แก้ไฟล์
bun run build           # bundle สำหรับ Bun ไปที่ build/index.js
```

ใช้ `bun run lint:fix` และ `bun run format:fix` เมื่อต้องการแก้ lint/format อัตโนมัติ

## ตั้งเวลา collector

บรรทัด cron ของ collector อยู่ที่ [`docs/crontab`](docs/crontab) แก้ host ให้ตรงกับที่ deploy แล้วต่อท้าย `crontab -e`

endpoint กลุ่ม `/stash` ไม่ต้องใช้ API key จึงเรียกจาก cron ได้ตรง ๆ

## Endpoints

### Read API

- `GET /health` — health check
- `GET /collector/cinema` — ข้อมูลหนัง; filter ได้ด้วย `genre`, `release_date`, `search`, `week`, `year`
- `GET /collector/cinema/theater?search=` — รายชื่อสาขา Major พร้อมชื่อไทย/อังกฤษและโซน (ดึงสด ไม่เก็บลง DB)
- `GET /collector/cinema/showtime?theater=&date=&movie=&time=&from=&to=&seats=` — รอบฉายสดของสาขา ต้องระบุช่วงเวลา (`time` หรือ `from`+`to`) และ `date` ได้แค่วันนี้/พรุ่งนี้ ใส่ `seats=true` เพื่อดูที่นั่งว่าง (ดึงทีละรอบ สูงสุด 10 รอบ)
- `GET /collector/cinema/showtime/:showtime/seat?detail=` — ผังที่นั่งสดของรอบนั้น จำนวนว่าง/ถูกจอง และราคาตั๋ว
- `GET /collector/cinema/:movie/:theater` — ทางลัดถามรอบฉายของหนังเรื่องหนึ่งที่สาขาหนึ่ง
- `GET /collector/gold?currency=USD|THB` — ราคาทองและกำไร/ขาดทุนจาก reminder
- `GET /collector/ont` — snapshot อุปกรณ์ ONT ล่าสุดจาก PostgreSQL
- `GET /collector/ont/:mac/history?from=&to=&limit=` — ประวัติสถานะต่อเครื่อง ย้อนหลัง 24 ชั่วโมงโดยค่าเริ่มต้น
- `GET /lottery?limit=24` — ประวัติผลรางวัลล่าสุด

### Public API (`/v1`)

`GET` อย่างเดียว ตอบ error เป็น `application/problem+json` รายละเอียดและรูปแบบ response อยู่ที่ [`docs/public-api.md`](docs/public-api.md)

- `GET /v1/coding` — สรุปเวลาเขียนโค้ด (WakaTime) และ repo/commit/LOC/ภาษา (GitHub)
- `GET /v1/coding/days?from=&to=` — วินาทีที่เขียนโค้ดรายวันแยกตาม category
- `GET /v1/telemetry?from=&to=` — work type และ AI-assisted (บรรทัด AI/human แยก added/removed, session, model, token)
- `GET /v1/repositories?owner=&sort=&limit=&cursor=` — repo สาธารณะของเจ้าของ
- `GET /v1/exchange-rates?ccy=USD,JPY&quote=THB` — อัตราแลกเปลี่ยนจาก Yahoo

### Collector jobs

- `PATCH /stash/currency?symbols=JPY,EUR` — ดึงอัตราแลกเปลี่ยนต่อ USD จาก Yahoo (THB เสมอ + สกุลที่เก็บไว้แล้ว + `symbols`)
- `PATCH /stash/github?full=true` — เก็บ repo/ภาษา/commit จาก GitHub GraphQL และ LOC จาก `stats/contributors` ใน background (`202`, ซ้อนกันได้ `409`)
- `PATCH /stash/cinema` — scrape รายการหนัง now-showing/coming-soon จาก Major Cineplex (และ SF Cinema เมื่อเข้าถึงได้) แล้ว upsert ลง bucket ของสัปดาห์ปัจจุบัน
- `POST /stash/cinema` — รับ batch ที่ scrape มาแล้ว รวมข้อมูลโรงหนัง และลบรายการซ้ำ
- `PATCH /stash/gold` — ดึงราคาทองล่าสุดแล้วบันทึก
- `PATCH /stash/ont` — ใช้ Chrome อ่าน ONT หนึ่งรอบ รวม AdGuard แล้วบันทึก; เรียกผ่าน curl จาก cron
- `PATCH /stash/lottery` — ดึงผลรางวัลล่าสุดแล้วบันทึก
- `PATCH /stash/lottery/bulk?date=YYYY-MM-DD` — เริ่ม backfill ผลรางวัลและตอบ `202` ทันที
- `PATCH /stash/mea` — ดึงมิเตอร์ ประวัติค่าไฟ และประวัติการชำระย้อนหลังแยกรายเดือน โดยจับคู่ `billNo` แบบคงเลขศูนย์นำหน้า
- `PATCH /stash/mwa` — login, ดึงทุกบัญชีที่ลงทะเบียนพร้อมประวัติใบเสร็จ/ค่าน้ำ และบันทึกแบบ upsert
- `PATCH /stash/solar?interval=1h` — เก็บ Solar ครบทั้ง record/key history, latest state, alarm, device snapshot, energy flow, config snapshot และ station summary; history ใช้ช่วงย้อนหลัง 3 ชั่วโมงโดยค่าเริ่มต้น
- `PATCH /stash/solar/bulk?date=YYYY-MM-DD` — เริ่ม backfill record/key history และ station summary รายวัน/เดือน/ปี พร้อม refresh ชุดข้อมูลที่ API มีเฉพาะค่าปัจจุบัน แล้วตอบ `202` ทันที
- `POST /reminder/gold` — บันทึกข้อมูลการลงทุนทองสำหรับการคำนวณ collector

## โครงสร้างโปรเจกต์

```text
src/
├── index.js                 # ประกอบ Elysia app และ lifecycle
├── config.js                # environment, logger และ metadata
├── db.js                    # PostgreSQL/Kysely และ migration runner
├── json.js                  # normalize JSONB ที่ driver คืนเป็น string
├── middleware.js            # request context, error/response logging, Swagger
├── reminders.js             # อ่าน/เขียน JSON reminder แบบรวมศูนย์
├── migrations/              # Kysely migrations
└── routes/
    ├── collector.js         # read APIs
    ├── reminder.js          # gold reminder
    └── stash/               # external collectors และ bulk jobs
        └── cinema/          # scrape/normalize/store ของ cinema collector
```

ไฟล์ `CLAUDE.md` บันทึกแนวทางดูแลโค้ด การเปลี่ยนแปลงเชิง technical debt และคำสั่ง verification ล่าสุด

รายละเอียดตาราง แหล่งข้อมูล และขอบเขตการ backfill ของ Solar อยู่ที่ [`docs/solar-schema.md`](docs/solar-schema.md)

รายละเอียดของ cinema collector แหล่งข้อมูล และข้อจำกัดของ SF Cinema อยู่ที่ [`docs/cinema-collector.md`](docs/cinema-collector.md)

รายละเอียด ONT collector, migration `010_ont`, Chromium, environment และตัวอย่าง curl อยู่ที่ [`docs/ont-collector.md`](docs/ont-collector.md)
