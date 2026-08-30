# Solar Web Handoff

เอกสารนี้สรุปสิ่งที่เพิ่มใน Solar collector และแนวทางนำข้อมูลไปทำหน้าเว็บ โดยรายละเอียดระดับ database schema อยู่ใน [`solar-schema.md`](solar-schema.md)

## สรุปสิ่งที่เพิ่ม

1. ขยาย telemetry เดิมให้เก็บได้ทั้งตัวเลขและข้อความ เช่น battery status, firmware version และ serial number โดยไม่ทำเลขศูนย์นำหน้าของรหัสอย่าง `011` หาย
2. เพิ่มการเก็บข้อมูล Solar ครบ 7 กลุ่ม:
   - Alarm history
   - Raw key history
   - Latest device state
   - Device details
   - Energy flow
   - Remote configuration
   - Station summary รายวัน/เดือน/ปี/สะสม
3. เพิ่ม snapshot สำหรับข้อมูลที่ upstream มีเฉพาะค่าปัจจุบัน เพื่อสร้างประวัติตั้งแต่เปิด collector เป็นต้นไป
4. เพิ่ม bulk backfill แบบ idempotent รันซ้ำได้โดยไม่สร้างข้อมูลซ้ำ
5. เก็บ raw JSONB ในชุดข้อมูลที่โครงสร้างอาจเปลี่ยน เช่น alarm, device, latest state, energy flow และ config
6. เพิ่ม transaction, pagination, validation, unit tests และเอกสาร schema

## สถานะข้อมูลหลัง Initial Backfill

ข้อมูล ณ วันที่ 2026-08-24:

- Telemetry เริ่มที่ `2026-05-11T10:51:36Z`
- Telemetry ในฐานประมาณ 5.44 ล้านแถว ขนาดตารางรวม index ประมาณ 1.4 GB
- Alarm 10 รายการ
- Config 6 รายการต่อ snapshot แรก
- Device, latest state และ energy flow อย่างละ 1 snapshot แรก
- Station summary 5,234 แถว
- Upstream ส่ง station daily bucket จริงตั้งแต่ 2026-05-26 แม้ telemetry จะเริ่มตั้งแต่ 2026-05-11

ตัวเลข snapshot จะเพิ่มขึ้นตามรอบ collector และไม่ควร hard-code ในหน้าเว็บ

## ตารางและการนำไปใช้บนหน้าเว็บ

| ตาราง                         | ข้อมูล                                         | UI ที่เหมาะสม                                                      |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `stash.solar_record`          | Telemetry ทุก attribute ตามเวลา                | กราฟ power, voltage, current, battery และรายละเอียดค่าล่าสุด       |
| `stash.solar_alarm`           | Alarm, ระดับ, เวลาเกิด/หาย และสถานะ            | Active alarm banner, alarm history, filter ตาม severity            |
| `stash.solar_device_snapshot` | สถานะ online, กำลังผลิต, รุ่นและข้อมูล station | Device header, status card, device information                     |
| `stash.solar_latest_state`    | Raw latest state ต่อ timestamp                 | Debug/detail drawer หรือ fallback เมื่อ field ใหม่ยังไม่มี mapping |
| `stash.solar_energy_flow`     | PV/grid/battery/load power และ direction       | Energy-flow diagram และ live power cards                           |
| `stash.solar_config_snapshot` | ค่า config ของ inverter                        | Settings summary และ config change history                         |
| `stash.solar_station_summary` | Power/energy bucket รายวัน เดือน ปี และ total  | Production charts และ period comparison                            |

## Metric สำคัญสำหรับหน้า Overview

ชื่อ attribute เป็น dynamic key ไม่ควรสร้าง database column ใหม่ต่อ metric

### Power

- `generationPower` — กำลังผลิต Solar รวม หน่วย kW
- `pv1Power`, `pv2Power` — กำลังผลิตแยก PV input
- `totalLoadPower` — กำลังโหลดรวม
- `aPhaseFeederPower` — กำลังไฟจาก/ไป Grid
- `batteryPower` — กำลัง charge/discharge ของ Battery
- `offGridPortTotalPower` — กำลังของ off-grid port

### Energy

- `dayPurchaseElectricityConsumption` — พลังงานที่ซื้อจาก Grid วันนี้
- `totalPurchaseElectricityConsumption` — พลังงานที่ซื้อจาก Gridสะสม
- `loadDayElectricityConsumption` — พลังงานที่ Load ใช้วันนี้
- `totalPowerGeneration` — พลังงานที่ผลิตสะสม
- Station summary ใช้ `pvGeneratedEnergy` หรือ `generatedEnergy` ตาม source

### Battery

- `batterySOC`, `batterySOH` — เปอร์เซ็นต์ความจุและสุขภาพ
- `batteryPower`, `batteryVoltage`, `batteryCurrent`
- `batteryStatus` — เก็บทั้ง raw code เช่น `011` และ display เช่น `Idle`
- `maxSingleBatteryCellTemperature`

### Grid และ Inverter

- `gridVoltage`, `aPhasegridVoltage`
- `aPhaseGridFrequency`
- `firmwareVersion`, `productSerialNumber`, `powerRating`

Metric อาจเพิ่มหรือลดตาม firmware/protocol ดังนั้น frontend ควรรองรับ unknown key และใช้ `name_display`/`unit` จาก backend เมื่อมีค่า

## กฎการเลือกค่ามาแสดง

Telemetry มีทั้งค่าตัวเลขและข้อความ:

```text
displayValue = value_display ?? value_text ?? String(value)
```

- ใช้ `value` สำหรับคำนวณและวาดกราฟ
- ใช้ `value_display` สำหรับ label ที่ upstream แปลงแล้ว เช่น `Idle`
- ใช้ `value_text` สำหรับ version, serial และรหัสที่ต้องรักษาเลขศูนย์นำหน้า
- เวลาในฐานเป็น `timestamptz`; หน้าเว็บควรแสดงด้วย timezone `Asia/Bangkok`

## หน้าเว็บที่แนะนำ

### 1. Solar Overview

- Online/offline และเวลาได้รับข้อมูลล่าสุด
- Solar generation, load, grid และ battery power ปัจจุบัน
- Battery SOC/SOH/status
- พลังงานผลิตวันนี้และสะสม
- Active alarm banner
- Energy-flow diagram จาก PV ไปยัง Grid/Battery/Load

### 2. Telemetry Charts

- Date range และ metric selector
- Preset 24 ชั่วโมง, 7 วัน, 30 วัน และ custom range
- แยกแกน/หน่วยเมื่อเลือก metric ต่างชนิด
- Downsample หรือ aggregate ฝั่ง backend ก่อนส่งช่วงเวลายาว เพราะ telemetry มีหลายล้านแถว

### 3. Energy Summary

- Daily generation power ใช้ `source = category_daily`
- Daily energy ในเดือนใช้ `source = category_monthly`
- Monthly energy ในปีใช้ `source = category_yearly`
- Total by year ใช้ `source = generated_total`
- ต้องระบุ `source` เสมอเพื่อไม่รวม bucket ต่าง granularity ซ้ำกัน

### 4. Alarm History

- Filter active/cleared, alarm key, level และช่วงเวลา
- แสดง `name`, `description`, `fired_at`, `cleared_at`, `fired_value`
- Active alarm คือรายการที่ `cleared_at IS NULL`
- Alarm key เป็น dynamic; ตัวอย่างที่พบคือ `batteryNoConnected` และ `shGridVoltageOutRange`

### 5. Device & Configuration

- Device/station name, serial, manufacturer, rated power และ firmware
- Last online/offline/data time
- Config ล่าสุด และ optional config history ตาม `observed_at`

## Collector API ที่มีแล้ว

Endpoint กลุ่มนี้ใช้สั่งเก็บข้อมูล ไม่ควรเรียกตรงจากหน้าเว็บทั่วไป:

### Refresh ทุกชุดข้อมูล

```http
PATCH /stash/solar?interval=1h
```

รองรับ interval เช่น `30m`, `1h`; ค่าเริ่มต้นคือ 3 ชั่วโมง และตอบผลโดยประมาณดังนี้:

```json
{
  "success": true,
  "counts": {
    "alarms": 10,
    "configSnapshots": 6,
    "deviceSnapshots": 1,
    "energyFlowSnapshots": 1,
    "latestStateSnapshots": 1,
    "stationSummaryRows": 324,
    "telemetryRows": 25016
  },
  "points": {
    "keyHistory": 131,
    "recordHistory": 130
  }
}
```

จำนวนจริงเปลี่ยนตามเวลาที่เรียกและข้อมูลจาก upstream

### Backfill

```http
PATCH /stash/solar/bulk?date=2026-05-11
```

- ตอบ `202 Accepted` ทันทีและทำงานเบื้องหลัง
- Backfill record/key history และ station summary
- Refresh alarm/device/latest/flow/config ปัจจุบันหนึ่งรอบก่อนเริ่ม

## Read API สำหรับ Frontend

ปัจจุบันยังไม่มี Solar read endpoint ใน `src/routes/collector.js` ดังนั้นหน้าเว็บยังไม่ควรเชื่อม database โดยตรง ควรเพิ่ม read API ที่ paginate/aggregate และจำกัดช่วงเวลา เช่น:

```text
GET /collector/solar/overview
GET /collector/solar/timeseries?attrs=generationPower,totalLoadPower&from=...&to=...&bucket=5m
GET /collector/solar/energy-summary?period=daily&from=...&to=...
GET /collector/solar/alarms?status=active&limit=50&cursor=...
GET /collector/solar/device
GET /collector/solar/configs
```

ข้อกำหนดสำหรับ read API:

- ทุก timeseries query ต้องมี `device_id` และ time range เพื่อใช้ index `(device_id, recorded_at)`
- จำกัดจำนวน point หรือ aggregate เป็น bucket เมื่อขอช่วงเวลายาว
- ใช้ cursor pagination สำหรับ alarm/config history
- ส่ง timestamp เป็น ISO 8601 และส่ง timezone ของ station เพิ่มใน overview
- ห้ามส่ง raw JSONB เป็นค่าเริ่มต้น; เปิดเฉพาะ detail/debug endpoint เมื่อจำเป็น
- Response ควรส่ง `value`, `displayValue`, `unit`, `name` และ `recordedAt` ให้ frontend ไม่ต้องรู้ schema EAV

## ข้อควรระวัง

- `PATCH /stash/solar/bulk` เป็นงานหนัก ไม่ควรเปิดให้ผู้ใช้ทั่วไปเรียกจากหน้าเว็บ
- Energy-flow direction เป็น upstream code; อย่า hard-codeความหมายก่อนกำหนด mapping ฝั่ง backend
- Snapshot table จะโตตามความถี่ collector ควรกำหนด retention/downsampling ภายหลังหากรันถี่
- ข้อมูลก่อนวันที่ upstream เริ่มส่งจริงจะไม่มีแถว และ frontend ควรแสดง `No data` แทนค่า 0
- `0` คือค่าจริง ส่วน `null`/ไม่มีแถวคือไม่มีข้อมูล ต้องแยกความหมายกัน
