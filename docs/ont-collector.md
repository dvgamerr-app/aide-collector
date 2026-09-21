# ONT collector

ย้าย collector จาก `ont-collector` มาเป็น API ใน aide-collector ใช้ Chrome ผ่าน Playwright อ่าน Fiberhome HG6142HT (AIS) และรวม DNS activity จาก AdGuard Home ลง PostgreSQL ไม่มี polling loop ภายใน ให้ crontab เรียกเก็บทีละรอบ

## เริ่มใช้งาน

1. `bun install`
2. ตั้ง `DATABASE_URL`, `ONT_PASS` และ `AG_PASS` (ถ้าต้องการรวม AdGuard) ใน `.env` ตาม `.env.example`
3. `bun run migration:run` ก่อนเริ่ม API เพื่อสร้างตารางจาก `010_ont`
4. `bun run start`

Windows ใช้ Google Chrome ที่ติดตั้งอยู่; Linux ใช้ Chromium ที่ `/usr/bin/chromium` หรือกำหนด `CHROME_PATH` เอง Dockerfile ติดตั้ง Chromium ให้แล้ว หลังอัปเดตต้อง build image ใหม่

`bun run build` เก็บ `playwright-core` เป็น external dependency เพราะ package มีไฟล์ runtime ของตัวเอง การรัน `build/index.js` ต้องมี production `node_modules` ด้วย

เครื่องที่รัน API ต้องเข้าถึง ONT และ AdGuard ผ่าน LAN ได้ รัน API ที่เก็บ ONT นี้เพียงหนึ่ง replica และหยุด collector เดิม เพราะ firmware อนุญาตเพียงหนึ่ง login session การล็อกใน PostgreSQL ป้องกันงานซ้อน แต่ไม่ได้แบ่ง browser session ระหว่าง replica

## API และ curl

```sh
# เก็บหนึ่ง snapshot แล้วตอบหลัง commit สำเร็จ
curl --fail-with-body -sS --max-time 120 -X PATCH http://localhost:3000/stash/ont

# อ่าน snapshot ล่าสุดจาก DB ไม่ยิง ONT
curl --fail-with-body -sS http://localhost:3000/collector/ont

# ประวัติต่อ MAC (ค่าเริ่มต้นย้อนหลัง 24 ชั่วโมง)
curl --fail-with-body -sS 'http://localhost:3000/collector/ont/AA:BB:CC:DD:EE:FF/history?limit=100'

# เลือกช่วงเวลา สูงสุด 31 วัน และสูงสุด 5,000 samples ต่อคำขอ
curl --fail-with-body -sS 'http://localhost:3000/collector/ont/AA:BB:CC:DD:EE:FF/history?from=2026-09-21T00:00:00Z&to=2026-09-22T00:00:00Z&limit=5000'
```

ใช้ `/stash` รูปแบบเดียวกับ collector เดิม ไม่ต้องส่ง API key ดู OpenAPI ที่ `/docs`

ผลเก็บสำเร็จมี `success`, `id`, `source`, `recorded_at`, `host_count`, `adguard_status`, `ont_requests`, `elapsed_ms` และ `skipped: false` หากเรียกถี่กว่า `ONT_MIN_INTERVAL` ตอบ HTTP 200 พร้อม `skipped: true`, `reason` และ `collection_id` ของรอบล่าสุด โดยไม่ยิง ONT

งานซ้อนตอบ 409, ONT ล้มเหลวตอบ 502 และปิด browser เพื่อเปิด session ใหม่ในรอบถัดไป ระหว่าง backoff ตอบ 429 พร้อม `Retry-After` (เริ่ม 120 วินาที สูงสุด 900 วินาทีที่ค่าเริ่มต้น) ไม่มี retry ภายใน request ค่า backoff และ cache ชื่ออยู่ใน memory จึงเริ่มใหม่เมื่อ restart API ส่วนช่วงห่างของ snapshot ตรวจจาก DB

AdGuard ล้มเหลวไม่ทำให้ snapshot ONT ล้มเหลว: `adguard_status` เป็น `unavailable` หรือ `backoff` และ `dns_queries` เป็น NULL หากไม่กำหนด `AG_PASS` จะเป็น `disabled` ส่วนชื่อที่อ่านสำเร็จเก็บ cache 15 นาที

GET ล่าสุดคืน `collection: null` และ `devices: []` เมื่อยังไม่มีข้อมูล หาก ONT รายงานรายการว่าง จะมี collection ใหม่พร้อม `devices: []` ไม่ย้อนกลับไปแสดงอุปกรณ์รอบเก่า GET history เรียงใหม่ไปเก่าและมี `has_more`; หากเป็น true ให้เพิ่ม limit หรือแบ่งช่วงเวลา

## Crontab

เพิ่มไว้ใน [`crontab`](crontab) แล้ว ให้ติดตั้งเองบนเครื่อง cron หลัง deploy API และตั้งค่า environment เรียบร้อย:

```cron
API=http://10.203.1.91:3001
LOG=/var/log/aide-collector.log
* * * * * out=$(curl -fsS --max-time 120 -X PATCH "$API/stash/ont" 2>&1); rc=$?; echo "$(date -Iseconds) [ont] $out" >> $LOG; exit $rc
```

Chrome/session ใช้ซ้ำระหว่างคำขอ ไม่มี timer ดึง ONT ระหว่างรอ cron และไม่มี adaptive interval ภายใน เปลี่ยนเป็น `*/5 * * * *` หากต้องการเก็บทุก 5 นาที ช่วงห่างขั้นต่ำเริ่มต้น 60 วินาที; cron ที่มาถึงก่อนครบช่วงจะถูกข้าม

## Environment

| ตัวแปร                | ค่าเริ่มต้น                          | ความหมาย                                          |
| --------------------- | ------------------------------------ | ------------------------------------------------- |
| `ONT_ID`              | `main`                               | ชื่อแหล่งข้อมูล คงเดิมเพื่ออ่านประวัติต่อเนื่อง   |
| `ONT_BASE`            | `http://10.203.1.1`                  | ONT origin                                        |
| `ONT_USER`            | `admin`                              | ONT username                                      |
| `ONT_PASS`            | ไม่มี                                | จำเป็น ไม่มี credential ฝังในโค้ด                 |
| `CHROME_PATH`         | Windows Chrome / `/usr/bin/chromium` | Browser executable                                |
| `ONT_MIN_INTERVAL`    | `60`                                 | ระยะขั้นต่ำระหว่าง snapshot เป็นวินาที ขั้นต่ำ 60 |
| `ONT_REQUEST_TIMEOUT` | `15`                                 | Timeout ของแต่ละ browser/API operation เป็นวินาที |
| `AG_BASE`             | `http://10.203.1.91:8080`            | AdGuard Home                                      |
| `AG_USER`             | `dvgamerr`                           | AdGuard username                                  |
| `AG_PASS`             | ว่าง                                 | ว่างคือปิด AdGuard                                |
| `AG_CLIENT_INTERVAL`  | `900`                                | ระยะ refresh ชื่อ AdGuard เป็นวินาที ขั้นต่ำ 60   |

## Database และความหมายข้อมูล

Migration `010_ont` สร้างตารางใหม่ใน schema `stash` โดยไม่เปลี่ยนตาราง collector เดิม:

| ตาราง             | Primary key          | หน้าที่                                                 |
| ----------------- | -------------------- | ------------------------------------------------------- |
| `ont_collections` | `id`                 | เวลารอบเก็บ แหล่งข้อมูล จำนวน hosts และสถานะ AdGuard    |
| `ont_devices`     | `source, mac`        | Identity ล่าสุด, first_seen, last_seen                  |
| `ont_addresses`   | `source, mac, ip`    | IP ที่เคยพบ, lease และเวลาอัปเดต                        |
| `ont_stats`       | `collection_id, mac` | สถานะ, IP ณ เวลานั้น, RSSI, link rate และ raw DNS count |

FK เชื่อม addresses/stats กับ devices และ stats กับ collections; ลบ collection จะลบ samples ของรอบนั้นด้วย มี index `(source, recorded_at DESC)` สำหรับรอบล่าสุด และ `(source, mac, recorded_at DESC)` สำหรับประวัติ Snapshot ทั้งชุดบันทึกด้วย transaction เดียว MAC ซ้ำใน response ถูกยุบก่อนบันทึก

- `last_seen` คือเวลาที่ ONT ยังรายงานอุปกรณ์ ใช้ `active` สำหรับสถานะออนไลน์
- อุปกรณ์ที่หายจาก response ไม่มี sample ใหม่ ไม่สร้าง offline ขึ้นเอง
- IP เก่าเก็บใน addresses แต่ GET ล่าสุดใช้ IP จาก snapshot จึงไม่เอา IP เก่ามารวมเป็นปัจจุบัน
- เก็บ 0 เป็น 0 และค่าที่ขาด/ไม่ใช่จำนวนเต็มเป็น NULL PostgreSQL bigint อาจแสดงเป็น JSON string ตาม driver
- `tx_rate`/`rx_rate` เป็น link rate ดิบ ไม่ใช่ byte counter และไม่ใช่ bandwidth ที่ใช้งานจริง
- `dns_queries` เป็น raw count ใน stats window ของ AdGuard; IP ที่ไม่อยู่ใน `top_clients` เป็น NULL การคำนวณ delta ต้องระวัง window reset/เลื่อนและ IP เปลี่ยนเจ้าของ
- Migration สร้าง schema สำหรับข้อมูลใหม่ ไม่ได้นำประวัติจาก `devices.db` เดิมเข้ามา
- ยังไม่ล้างประวัติอัตโนมัติ การ rollback ด้วย `migration:down` จะลบตาราง ONT และข้อมูลทั้งหมดในตารางเหล่านี้

## ผลตรวจ 2026-09-21

Migration `010_ont` apply บน DB `collector` แล้ว เรียก API ผ่าน curl กับ ONT/AdGuard จริงได้ 21 อุปกรณ์ รอบที่ใช้ session เดิมส่ง 2 ONT requests และใช้เวลาประมาณ 0.5 วินาที ตรวจ GET ล่าสุด/ย้อนหลัง, lease/address source, การข้ามคำขอที่ถี่เกินไป, validation และการป้องกันคำขอซ้อนทั้งใน process และผ่าน DB lock แล้ว

Test เดิม 53 รายการ, lint, format, Bun build และการเปิด bundled API ผ่านทั้งหมด Docker image build สำเร็จและเปิด Chromium headless ได้ ยังไม่ได้ deploy API หรือติดตั้ง crontab บนเครื่องปลายทาง
