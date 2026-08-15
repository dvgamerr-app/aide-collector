# Aide Collector

REST API สำหรับรวบรวมและอ่านข้อมูล cinema, gold, lottery, MEA, solar และ reminder พร้อม endpoint สำหรับจัดการ API token สร้างด้วย Bun, Elysia, Kysely และ PostgreSQL

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

> Migration ไม่ได้ทำงานอัตโนมัติตอน boot ต้องรัน `bun run migration:run` หลังสร้างฐานข้อมูลและทุกครั้งที่มี migration ใหม่

## ตัวแปรสภาพแวดล้อม

| ตัวแปร                  | จำเป็น               | รายละเอียด                                                            |
| ----------------------- | -------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`          | ใช่                  | PostgreSQL connection string                                          |
| `PORT`                  | ไม่                  | พอร์ตของ API ค่าเริ่มต้น `3000`                                       |
| `LOG_LEVEL`             | ไม่                  | ระดับ log ของ Pino ค่าเริ่มต้น `info`                                 |
| `MASTER_KEY`            | ไม่                  | key สำหรับ bootstrap/จัดการ token โดยไม่ต้องมี record ใน `api_keys`   |
| `MEA_PAYLOAD`           | เฉพาะ MEA            | Base64 ของ JSON `{ "username", "password" }`                          |
| `SOLAR_DEVICE_ID`       | เฉพาะ Solar          | device ID ที่จะรวบรวมข้อมูล                                           |
| `SOLAR_OPEN_APP_ID`     | เฉพาะ Solar          | App ID ของ Solar Open API                                             |
| `SOLAR_OPEN_APP_SECRET` | เฉพาะ Solar          | encrypted App Secret สำหรับลงลายเซ็น request                          |
| `SOLAR_PAYLOAD`         | เฉพาะ Solar          | Base64 ของ JSON `{ "account", "password" }` โดย password เป็น MD5 hex |
| `DISCORD_WEBHOOK`       | เฉพาะแจ้งเตือน Solar | webhook สำหรับแจ้งเมื่ออุปกรณ์ offline เกิน 15 นาทีและกลับมา online   |

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

## Endpoints

### Read API

- `GET /health` — health check
- `GET /collector/cinema` — ข้อมูลหนัง; filter ได้ด้วย `genre`, `release_date`, `search`, `week`, `year`
- `GET /collector/gold?currency=USD|THB` — ราคาทองและกำไร/ขาดทุนจาก reminder
- `GET /lottery?limit=24` — ประวัติผลรางวัลล่าสุด

### Collector jobs

- `POST /stash/cinema` — upsert และรวมข้อมูลโรงหนังที่ซ้ำกัน
- `PATCH /stash/gold` — ดึงราคาทองล่าสุดแล้วบันทึก
- `PATCH /stash/lottery` — ดึงผลรางวัลล่าสุดแล้วบันทึก
- `PATCH /stash/lottery/bulk?date=YYYY-MM-DD` — เริ่ม backfill ผลรางวัลและตอบ `202` ทันที
- `PATCH /stash/mea` — ดึงมิเตอร์และประวัติค่าไฟ MEA
- `PATCH /stash/solar?interval=1h` — ดึง timeseries ย้อนหลัง; รองรับหน่วย `m`/`h` และค่าเริ่มต้น 3 ชั่วโมง
- `PATCH /stash/solar/bulk?date=YYYY-MM-DD` — เริ่ม backfill Solar รายวันและตอบ `202` ทันที
- `POST /reminder/gold` — บันทึกข้อมูลการลงทุนทองสำหรับการคำนวณ collector

### Token API

- `GET /v1/token` — แสดง active tokens
- `POST /v1/token` — สร้าง token
- `DELETE /v1/revoke` — revoke token ของผู้เรียก

endpoint กลุ่ม `/v1` ต้องส่ง header `X-API-Key` ที่ active หรือใช้ `MASTER_KEY` หากกำหนดไว้

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
    ├── token.js             # API-token lifecycle
    └── stash/               # external collectors และ bulk jobs
```

ไฟล์ `CLAUDE.md` บันทึกแนวทางดูแลโค้ด การเปลี่ยนแปลงเชิง technical debt และคำสั่ง verification ล่าสุด
