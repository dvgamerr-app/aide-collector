# Solar collector schema

สำหรับสรุปเพื่อทำหน้าเว็บและแนวทางออกแบบ UI/read API ดู [`solar-web-handoff.md`](solar-web-handoff.md)

Collector ใช้ device จาก `SOLAR_DEVICE_ID` และเก็บข้อมูลจาก Solar portal ทั้ง 7 กลุ่ม นอกเหนือจาก record-list เดิม โดย migration อยู่ที่ `src/migrations/008_solar_extended.js`

## ตาราง

| ตาราง                         | รูปแบบ                                                                            | แหล่งข้อมูล                                                              | การเก็บย้อนหลัง                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `stash.solar_record`          | EAV ตาม `(device_id, attr, recorded_at)`; รองรับทั้ง `value` และ `value_text`     | record list, key history, latest state และ state ที่แนบมากับ energy flow | record list และ key history ย้อนหลังรายวันได้; latest state ไม่มี historical API |
| `stash.solar_alarm`           | หนึ่งแถวต่อ upstream alarm ID พร้อมสถานะเวลา clear และ raw JSONB                  | alarm query                                                              | ดึงทุกหน้าที่บัญชีเข้าถึงได้                                                     |
| `stash.solar_device_snapshot` | snapshot รายครั้ง พร้อมคอลัมน์สำคัญและ raw JSONB                                  | device details                                                           | API มีเฉพาะปัจจุบัน จึงเริ่มสร้าง history หลังเปิด collector                     |
| `stash.solar_latest_state`    | snapshot ตาม timestamp ของอุปกรณ์พร้อม raw JSONB; field ถูกแตกเข้า `solar_record` | latest device state                                                      | API มีเฉพาะค่าล่าสุด                                                             |
| `stash.solar_energy_flow`     | snapshot ตามเวลาข้อมูลของอุปกรณ์ พร้อม power/SOC/direction และ raw JSONB          | device energy flow                                                       | API มีเฉพาะปัจจุบัน                                                              |
| `stash.solar_config_snapshot` | snapshot ต่อ config key พร้อมชนิด ค่าแสดงผล และ raw JSONB                         | remote config cache                                                      | API มีเฉพาะปัจจุบัน จึงเริ่มสร้าง change history หลังเปิด collector              |
| `stash.solar_station_summary` | time bucket แบบ generic แยก `source`, `category_key`, `attr`, `time_key`          | station category และ generated-energy summary                            | daily, monthly, yearly และ total ที่ upstream มีให้                              |

`solar_record.source` ระบุ endpoint ที่ให้ค่าล่าสุดของ key/timestamp นั้น ส่วน `value_display`, `unit` และ `name_display` เก็บ metadata จาก latest/flow เมื่อมีข้อมูล ข้อความที่เป็นตัวเลขแต่มีความหมายเชิงรหัส เช่น `011` จะเก็บค่าต้นฉบับใน `value_text` ด้วยเพื่อไม่ให้เลขศูนย์นำหน้าหาย

## Collector behavior

- `PATCH /stash/solar` ดึง record/key history ตาม trailing window และ refresh ข้อมูลปัจจุบันครบทุกกลุ่ม
- `PATCH /stash/solar/bulk?date=YYYY-MM-DD` ทำงานเบื้องหลังแบบ idempotent ตั้งแต่วันนี้ย้อนถึงวันที่กำหนด
- Bulk ดึง record history, raw key history และ station daily ทีละวัน จากนั้นเติม station monthly/yearly/total
- Alarm ดึงแบบ pagination ทั้งหมด ส่วน device details, latest state, energy flow และ config ไม่มี API ย้อนหลัง จึงเก็บได้ตั้งแต่เวลาที่ collector เริ่มทำงาน
- ทุก history/summary table ใช้ primary key และ upsert เพื่อให้รันซ้ำได้โดยไม่สร้างข้อมูลซ้ำ
- Initial backfill เมื่อ 2026-08-24 พบ record/key telemetry ตั้งแต่ 2026-05-11 แต่ upstream ส่ง station daily bucket จริงตั้งแต่ 2026-05-26 เท่านั้น; ช่วงก่อนหน้านั้น collector ไม่สร้างแถวสมมติแทนข้อมูลที่ API ไม่ส่ง

## Query notes

- คำนวณ telemetry ใช้ `value`; แสดงรหัส/สถานะ/เวอร์ชันใช้ `COALESCE(value_text, value_display, value::text)`
- Query station summary ต้องระบุ `source` เพื่อไม่รวม bucket คนละระดับ เช่น `category_monthly` กับ `category_yearly`
- Snapshot ปัจจุบันของ device/config ใช้ `ORDER BY observed_at DESC LIMIT 1`
