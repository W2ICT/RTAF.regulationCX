// ฝังข้อมูล data/docs.json (gzip + base64) ลงใน index.html ให้เป็นไฟล์เดียวที่เปิดตรงๆ ได้
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data/docs.json");
const HTML = path.join(ROOT, "index.html");

// แปลงเลขไทยเป็นเลขอารบิกทุกช่องข้อความ (ทำซ้ำได้ ไม่เสียหาย) แล้วเขียนกลับ data/docs.json
const arabic = v => typeof v === "string" ? v.replace(/[๐-๙]/g, d => "๐๑๒๓๔๕๖๗๘๙".indexOf(d))
  : Array.isArray(v) ? v.map(arabic) : v;
const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
for (const d of data.docs) for (const k of ["title", "category", "tags", "text"]) d[k] = arabic(d[k]);
for (const d of data.docs) d.title = d.title.replace(/[​﻿]/g, "").replace(/\s+/g, " ").trim(); // ตัดอักขระล่องหน
// ตัดขีดนำหน้าที่ติดมาจากรายการย่อยบนเว็บ เช่น "- - ", "-- "
for (const d of data.docs) d.title = d.title.replace(/^[-–>»\s]+(?=\S)/, "");
// ตัดเลขลำดับข้อที่ติดมาจากหน้าเว็บ เช่น "1. ", "10) " (เลขไทยแปลงเป็นอารบิกแล้วข้างบน)
for (const d of data.docs) d.title = d.title.replace(/^\d{1,2}\s*[.)]\s*(?=\D)/, "").trim();
// title_overrides ใน sources.json: แก้ชื่อที่เว็บต้นทางตัดสั้น/ผิด  { "ชื่อเดิมที่ได้มา": "ชื่อที่ถูกต้อง" } (เฉพาะรายการของแหล่งนั้น)
{
  const srcs = JSON.parse(fs.readFileSync(path.join(ROOT, "crawler/sources.json"), "utf8")).sources;
  for (const s of srcs) {
    if (!s.title_overrides) continue;
    for (const d of data.docs) if ((d.srcKey || "").startsWith(s.id) && s.title_overrides[d.title]) d.title = s.title_overrides[d.title];
  }
}
// เติมปีให้รายการที่ยังไม่มี จากชื่อเรื่องแบบ "ปี 69" / "ปีงบประมาณ 68" (ช่วง 50-99 -> 2550-2599)
for (const d of data.docs) {
  if (d.year) continue;
  const m = d.title.match(/ปี(?:งบประมาณ)?\s*(\d{2})(?!\d)/);
  if (m && Number(m[1]) >= 50) d.year = 2500 + Number(m[1]);
}
// ตัดรายการซ้ำ: ไฟล์เดียวกัน (sha1 เท่ากัน) หรือเนื้อหาข้อความเหมือนกัน หรือ ชื่อ+ขนาดเท่ากัน (กรณีไม่มีข้อความ) -> เก็บฉบับแรก
const normTitle = t => t.replace(/\s+/g, "").toLowerCase();
const seen = new Map(), kept = [];
for (const d of data.docs) {
  const keys = [d.sha1 && "h:" + d.sha1, d.text && d.text.length > 200 && "t:" + d.text, !d.text && d.sizeMB && "n:" + normTitle(d.title) + "|" + d.sizeMB].filter(Boolean);
  const hit = keys.map(k => seen.get(k)).find(Boolean);
  if (hit) {
    (hit.alsoIn ||= []).push({ id: d.id, dept: d.dept, url: d.url, srcKey: d.srcKey }, ...(d.alsoIn || []));
    console.log(`ซ้ำ: "${d.title.slice(0, 50)}" (${d.dept}) = "${hit.title.slice(0, 50)}" (${hit.dept})`);
    continue;
  }
  keys.forEach(k => seen.set(k, d));
  kept.push(d);
}
data.docs = kept;
const raw = JSON.stringify(data);
fs.writeFileSync(DATA, JSON.stringify(data, null, 1));
const b64 = zlib.gzipSync(Buffer.from(raw), { level: 9 }).toString("base64");
const html = fs.readFileSync(HTML, "utf8");
const block = `<!--DATA--><script id="embedded" type="application/octet-stream">${b64}</script><!--/DATA-->`;
if (!/<!--DATA-->[\s\S]*?<!--\/DATA-->/.test(html)) throw new Error("ไม่พบตำแหน่งฝังข้อมูลใน index.html");
let out = html.replace(/<!--DATA-->[\s\S]*?<!--\/DATA-->/, () => block);
// ชุดข้อมูลที่เข้ารหัส (หน่วยที่ต้องใส่รหัสก่อนดู เช่น ยก.ทอ.) จาก data/locked/*.enc.json — ฝังเป็นข้อความเข้ารหัสอย่างเดียว ไม่มีรหัส/ข้อความธรรมดาในไฟล์
{
  const dir = path.join(ROOT, "data/locked");
  const blobs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".enc.json")).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) : [];
  const lockedBlock = `<!--LOCKED--><script id="locked" type="application/json">${JSON.stringify(blobs)}</script><!--/LOCKED-->`;
  const a = out.indexOf("<!--LOCKED-->"), z = out.indexOf("<!--/LOCKED-->");
  if (a < 0 || z < 0) throw new Error("ไม่พบตำแหน่งฝังข้อมูลที่เข้ารหัสใน index.html");
  out = out.slice(0, a) + lockedBlock + out.slice(z + "<!--/LOCKED-->".length);
  console.log(`ฝังชุดข้อมูลที่เข้ารหัส ${blobs.length} ชุด`);
}
fs.writeFileSync(HTML, out);
console.log(`ฝังข้อมูลแล้ว: ${(raw.length / 1048576).toFixed(1)} MB -> ${(b64.length / 1048576).toFixed(1)} MB ใน index.html`);
