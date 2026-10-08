// เข้ารหัส/ถอดรหัสชุดข้อมูลของหน่วยที่ต้องใส่รหัสก่อนดู (เช่น ยก.ทอ.)
//   RTAF_LOCK_PW=<รหัส> node crawler/lock.mjs encrypt <plain.json> <out.enc.json> <ชื่อหน่วย เช่น ยก.ทอ.>
//   RTAF_LOCK_PW=<รหัส> node crawler/lock.mjs decrypt <in.enc.json> <plain.json>
// รหัสอ่านจากตัวแปรสภาพแวดล้อมเท่านั้น ไม่ถูกบันทึกลงไฟล์ใดๆ
// อัลกอริทึม: PBKDF2-SHA256 (ซ้ำ 250,000 รอบ) -> AES-256-GCM  (ฝั่งเบราว์เซอร์ถอดด้วย WebCrypto ใน index.html)
import fs from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const ITER = 250000;
const [, , mode, input, output, label] = process.argv; // label = ชื่อหน่วยที่แสดงในตัวกรอง (ไม่เข้ารหัส)
const pw = process.env.RTAF_LOCK_PW;
if (!mode || !input || !output || !pw) { console.error("ใช้: RTAF_LOCK_PW=... node crawler/lock.mjs encrypt|decrypt <in> <out>"); process.exit(1); }

const b64 = u8 => Buffer.from(u8).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
async function key(salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

if (mode === "encrypt") {
  const plain = fs.readFileSync(input);
  JSON.parse(plain.toString("utf8")); // ตรวจว่าเป็น JSON
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(salt, ITER), plain));
  fs.mkdirSync(output.replace(/[/][^/]*$/, ""), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ v: 1, name: label || undefined, kdf: "PBKDF2-SHA256", iter: ITER, cipher: "AES-256-GCM", salt: b64(salt), iv: b64(iv), data: b64(ct) }));
  console.log("เข้ารหัสแล้ว ->", output, `(${ct.length} ไบต์)`);
} else if (mode === "decrypt") {
  const e = JSON.parse(fs.readFileSync(input, "utf8"));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, await key(unb64(e.salt), e.iter), unb64(e.data));
    fs.writeFileSync(output, Buffer.from(pt));
    console.log("ถอดรหัสแล้ว ->", output);
  } catch { console.error("รหัสไม่ถูกต้อง หรือไฟล์เสียหาย"); process.exit(2); }
} else { console.error("mode ต้องเป็น encrypt หรือ decrypt"); process.exit(1); }
