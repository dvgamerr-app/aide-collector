# Aide Collector

REST API สำหรับเก็บ/เสิร์ฟข้อมูล (cinema, gold, lottery, reminder) พร้อมระบบ API token
สร้างด้วย Elysia + Bun + Kysely (PostgreSQL)

## การติดตั้งเริ่มต้น

### 1. เตรียมฐานข้อมูล

ตั้งค่า `DATABASE_URL` ใน `.env` (ดู `.env.example`) แล้วสตาร์ทเซิร์ฟเวอร์ —
ตาราง schema จะถูกสร้างให้อัตโนมัติจาก `src/schema.sql` ตอน boot

```bash
docker compose up -d db   # postgres สำหรับ dev
bun install
bun dev
```

## ตัวแปรสภาพแวดล้อม

- `DATABASE_URL`: connection string ของ PostgreSQL (จำเป็น)
- `DISCORD_WEBHOOK`: Discord webhook สำหรับแจ้งเตือนเมื่ออุปกรณ์ Solar Offline เกิน 15 นาที และกลับมา Online
- `MASTER_KEY`: API key พิเศษสำหรับ bootstrap/จัดการ token โดยไม่ต้องมี record ในตาราง `api_keys` มาก่อน (ไม่บังคับ)
- `PORT`: พอร์ตที่เซิร์ฟเวอร์จะทำงาน (ค่าเริ่มต้น: 3000)
- `LOG_LEVEL`: ระดับ log ของ pino (ค่าเริ่มต้น: info)

## Endpoints

- `GET /health` — health check
- `GET /collector/cinema` — ดึงข้อมูลหนังที่ฉาย (filter: genre, release_date, search, week, year)
- `GET /collector/gold` — ราคาทอง + กำไร/ขาดทุนจากข้อมูลการลงทุน
- `POST /stash/cinema` — upsert ข้อมูลหนัง
- `PATCH /stash/gold` — ดึงราคาทองสดแล้วบันทึก
- `POST /reminder/gold` — อัปเดตข้อมูลการลงทุนทอง
- `GET /lottery` — ประวัติผลรางวัล (latest first)
- `GET|POST /v1/token`, `DELETE /v1/revoke` — จัดการ API token (header `X-API-Key`)
  - ถ้าตั้ง `MASTER_KEY` ไว้ สามารถใช้ key นี้เรียก endpoint กลุ่ม token ได้ทันทีโดยไม่ต้อง seed `api_keys`

API docs (Swagger): `GET /docs`
