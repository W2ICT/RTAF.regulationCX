// ดึงเอกสารสาธารณะตาม crawler/sources.json แล้วสร้าง data/docs.json
// - เคารพ robots.txt, หน่วงเวลาระหว่างคำขอ, ไม่ดาวน์โหลดซ้ำ (ใช้เลข /web/content/<id> เป็นกุญแจ)
// - เก็บเฉพาะ metadata + ข้อความที่สกัดได้ ลิงก์กลับไปไฟล์ต้นฉบับ
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "crawler/sources.json"), "utf8"));
const OUT = path.join(ROOT, "data/docs.json");
const S = cfg.settings;
const only = process.argv[2]; // node crawler/crawl.mjs <source-id> เพื่อดึงแหล่งเดียว
const limit = Number(process.argv[3] || Infinity); // จำกัดจำนวนไฟล์ ใช้ทดสอบ

const sleep = ms => new Promise(r => setTimeout(r, ms));
const robots = new Map();

async function robotsFor(origin) {
  if (robots.has(origin)) return robots.get(origin);
  const rules = [];
  try {
    const r = await fetch(origin + "/robots.txt", { headers: { "user-agent": S.user_agent } });
    if (r.ok) {
      let applies = false;
      for (const raw of (await r.text()).split(/\r?\n/)) {
        const line = raw.split("#")[0].trim();
        const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === "user-agent") applies = v === "*";
        else if (applies && k === "disallow" && v) rules.push(v);
      }
    }
  } catch {}
  robots.set(origin, rules);
  return rules;
}

async function allowed(url) {
  if (!S.respect_robots_txt) return true;
  const u = new URL(url);
  const rules = await robotsFor(u.origin);
  return !rules.some(p => u.pathname.startsWith(p));
}

async function get(url, { head = false } = {}) {
  if (!(await allowed(url))) { console.log("  ข้าม (robots.txt):", url); return null; }
  await sleep(S.delay_seconds * 1000);
  try {
    const r = await fetch(url, {
      method: head ? "HEAD" : "GET",
      headers: { "user-agent": S.user_agent },
      signal: AbortSignal.timeout(S.timeout_seconds * 1000 * (head ? 1 : 4)),
      redirect: "follow",
    });
    if (!r.ok) { console.log("  HTTP", r.status, url); return null; }
    return r;
  } catch (e) {
    console.log("  ผิดพลาด", url, e.message);
    return null;
  }
}

// ชื่อไฟล์จาก Content-Disposition (รองรับ filename*=UTF-8'' ภาษาไทย)
function dispositionName(h) {
  if (!h) return "";
  const star = h.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1] : "";
}

const cleanTitle = n => n.replace(/[​﻿]/g, "").replace(/\.(pdf|docx?)$/i, "").replace(/^\s*\d+(-\d+)?[\s-]+/, "").replace(/[_]+/g, " ").replace(/[\s ]+/g, " ").trim();
const arabic = s => s.replace(/[๐-๙]/g, d => "๐๑๒๓๔๕๖๗๘๙".indexOf(d));
const thaiYear = raw => {
  const s = arabic(raw);
  const m = s.match(/(25\d{2})/);
  if (m) return Number(m[1]);
  const m2 = s.match(/(?:ม\.ค|ก\.พ|มี\.ค|เม\.ย|พ\.ค|มิ\.ย|ก\.ค|ส\.ค|ก\.ย|ต\.ค|พ\.ย|ธ\.ค)\.?\s*(\d{2})(?!\d)/);
  if (m2) return 2500 + Number(m2[1]);
  const m3 = s.match(/ปี(?:งบประมาณ)?\s*(\d{2})(?!\d)/); // "ปี 69", "ปีงบประมาณ 68"
  return m3 && Number(m3[1]) >= 50 ? 2500 + Number(m3[1]) : null;
};
const keyOf = href => fileKey(href) || href.split("#")[0];
const fileKey = href => (href.match(/\/web\/content\/(\d+)/) || [])[1] || (href.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || [])[1];

function classify(title, src, group) {
  if (group && src.group_is_category) return group;
  for (const [cat, kws] of Object.entries(cfg.category_keywords || {})) if (kws.some(k => (title + " " + (group || "")).includes(k))) return cat;
  return src.default_category || "อื่นๆ";
}

async function pdfText(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages && out.length < S.max_text_chars; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  await doc.destroy();
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, S.max_text_chars);
}

// เก็บลิงก์ไฟล์จากหน้าเดียว คืน [{href, text}]
function filesOnPage($, base, src) {
  const re = new RegExp(src.file_url_regex || "\\.(pdf|docx?)(\\?|$)", "i");
  // link_only_regex: ลิงก์ที่เก็บเป็นรายการเฉยๆ ไม่ดาวน์โหลด (เช่น Google Drive ที่ robots.txt ห้าม, หนังสือ flipbook)
  const reLink = src.link_only_regex ? new RegExp(src.link_only_regex, "i") : null;
  const out = [];
  let order = new Map(), headings = [];
  if (src.group_heading_selector) {
    $("*").each((i, e) => order.set(e, i));
    headings = $(src.group_heading_selector).toArray().map(h => ({ i: order.get(h), t: $(h).text().replace(/[\s ]+/g, " ").trim() })).filter(h => h.t);
  }
  $(src.file_link_selector || "a[href]").each((_, a) => {
    let href;
    try { href = new URL($(a).attr("href"), base).href.replace("http://web/", base.origin + "/"); } catch { return; } // ข้ามลิงก์ที่ไม่ใช่ URL (เช่น tel:)
    // url_rewrites: แก้ลิงก์ที่เว็บต้นทางพิมพ์ผิด เช่น {"/web/content/35567/": "/web/content/3557/"}
    for (const [from, to] of Object.entries(src.url_rewrites || {})) href = href.replace(from, to);
    const linkOnly = !!(reLink && reLink.test(href));
    if (!linkOnly && !re.test(href)) return;
    const isDownload = /[?&]download=true/.test(href);
    const cleanHref = href.replace(/&download=true/, "").replace(/\?download=true&?/, "?");
    const panel = $(a).closest(".collapse");
    let group = panel.length ? panel.prev(".card-header").text().replace(/\s+/g, " ").trim() : "";
    // ลิงก์อยู่ในหน้าต่าง modal (Bootstrap): ใช้ชื่อหัว modal เป็นกลุ่ม
    if (!group) { const m = $(a).closest(".modal"); if (m.length) group = m.find(".modal-title").first().text().replace(/[\s ]+/g, " ").trim(); }
    // group_heading_selector: ใช้หัวข้อที่อยู่ก่อนลิงก์ (ตามลำดับในเอกสาร) เป็นชื่อกลุ่ม เช่น h3 "คำสั่งกองทัพอากาศ"
    if (!group && headings.length) {
      const pos = order.get(a);
      for (const h of headings) { if (h.i < pos) group = h.t; else break; }
    }
    let text = ($(a).text() || "").replace(/[\s ]+/g, " ").trim();
    if (!/[ก-๙A-Za-z0-9]/.test(text)) text = ""; // ข้อความในลิงก์เป็นแค่ขีด/เครื่องหมาย (เช่น "-") ถือว่าไม่มีชื่อ
    // ลิงก์เป็นแค่ไอคอน: ใช้ข้อความเซลล์แรกของแถวตาราง หรือ alt ของรูป
    if (!text) { const tr = $(a).closest("tr"); if (tr.length) {
      // เซลล์แรกที่ไม่ใช่เลขลำดับล้วนๆ (เช่น "1", "๒.") และมีข้อความพอจะเป็นชื่อ
      const cell = tr.find("td").toArray().map(td => $(td).text().replace(/\s+/g, " ").trim()).find(t => t && !/^[0-9๐-๙]+[.)]?$/.test(t));
      text = cell || "";
    } }
    // ไอคอนเปล่า: ใช้ข้อความที่ตามหลังลิงก์ จนถึงลิงก์ถัดไป (ข้าม <img>, <br> แทนด้วยช่องว่าง)
    // title_from: "before" = ชื่อเอกสารเป็นข้อความที่อยู่ก่อนไอคอนลิงก์ (ย้อนขึ้นไปจนถึง <br> หรือลิงก์ก่อนหน้า)
    if (!text && src.title_from === "before") {
      let parts = "";
      for (let n = a.previousSibling; n; n = n.previousSibling) {
        if (n.type === "tag" && n.name === "br") break;
        if (n.type === "tag" && n.name === "a" && n.attribs.href) break;
        parts = (n.type === "text" ? n.data : n.type === "tag" ? $(n).text() : "") + parts;
      }
      text = parts.replace(/[\s ]+/g, " ").trim();
    }
    if (!text && src.title_from !== "before") {
      let parts = "";
      for (let n = a.nextSibling; n; n = n.nextSibling) {
        if (n.type === "tag" && n.name === "a") break;
        if (n.type === "text") parts += n.data;
        else if (n.type === "tag" && n.name === "br") parts += " ";
        else if (n.type === "tag" && n.name !== "img") parts += $(n).text();
      }
      text = parts.replace(/[\s ]+/g, " ").trim();
    }
    if (!text) text = ($(a).find("img").attr("alt") || "").trim();
    // title_from_img: การ์ดรูปปกไม่มีข้อความ -> ใช้ชื่อไฟล์รูปปก (ถ้าไม่ใช่ชื่อแม่แบบทั่วไป เช่น Canva "สีน้ำเงิน ... ปก")
    if (!text && src.title_from_img) {
      const isrc = $(a).find("img").attr("src") || "";
      let stem = ""; try { stem = decodeURIComponent(isrc.split("?")[0].split("/").pop()).replace(/\.(png|jpe?g|webp|gif)$/i, ""); } catch {}
      stem = stem.replace(/^ปก\s*[-–]\s*/, "").replace(/\s+/g, " ").trim();
      if ((stem.match(/[ก-๙]/g) || []).length >= 15 && !/สีน้ำเงิน|สีฟ้า|โมเดิร์น|หน้าปก|Navy|Canva|untitled|download|image/i.test(stem)) text = stem;
    }
    // ลิงก์ดาวน์โหลดที่ไม่มีชื่อ: ใช้ชื่อไฟล์จาก title ก็ต่อเมื่อไม่มีทางอื่น (ปล่อยว่างแล้วให้ชื่อไฟล์จาก header ทำงาน)
    out.push({ href: isDownload ? cleanHref : href, text, group, linkOnly });
  });
  return out;
}

async function crawlSource(src, docs) {
  console.log("[ดึง]", src.id);
  // src.items: รายการที่ระบุเองในไฟล์ตั้งค่า (เช่น ไฟล์ในโฟลเดอร์ Drive ที่ดึงอัตโนมัติไม่ได้) เก็บเป็นรายการลิงก์
  if (src.items) {
    for (const it of src.items) {
      const key = it.url.split("#")[0];
      const id = crypto.createHash("sha1").update(src.id + key).digest("hex").slice(0, 12);
      if (seenId(id)) continue;
      // same_as: ข้อความในชื่อของรายการเดิมที่เป็นเอกสารฉบับเดียวกัน (ซ้ำข้ามหน่วย) -> ไม่สร้างใหม่ เก็บเป็นที่มาอื่น (alsoIn) ของรายการเดิม
      if (it.same_as) {
        const dupItem = [...docs.values()].find(d => d.title.includes(it.same_as));
        if (dupItem) {
          (dupItem.alsoIn ||= []).push({ id, dept: src.dept, url: it.url, srcKey: src.id + key });
          knownKeys.add(src.id + key);
          console.log(`  = ซ้ำกับ "${dupItem.title.slice(0, 50)}" (${dupItem.dept}) รวมเป็นรายการเดียว`);
          continue;
        }
      }
      console.log(`  + [ลิงก์] ${it.title.slice(0, 60)}`);
      docs.set(id, {
        id, title: arabic(it.title), sha1: "", srcKey: src.id + key,
        dept: src.dept, category: it.category || src.default_category || "อื่นๆ",
        tags: [...new Set([...(src.default_tags || []), ...(it.tags || [])])],
        year: it.year || thaiYear(it.title), status: it.status || "ใช้บังคับ",
        url: it.url, source: src.source_page || it.url, linkOnly: true,
        sizeMB: it.sizeMB, fetched: new Date().toISOString().slice(0, 10), text: "",
      });
    }
    return;
  }
  // cards: หน้าที่รายการเป็น "การ์ด" (ไม่มีไฟล์แนบตรงๆ ลิงก์ไปเว็บหน่วยงานอื่น) เก็บเป็นรายการลิงก์
  //   { item: ตัวเลือกการ์ด, group: หัวเรื่อง/ประเภทในการ์ด, title: ชื่อเรื่อง, link: ลิงก์ } ชื่อ = group + " " + title
  if (src.cards) {
    const normT = t => arabic(t).replace(/\s+/g, "").toLowerCase();
    let n = 0;
    for (const start of src.start_urls) {
      const r = await get(start);
      if (!r) continue;
      const $c = cheerio.load(await r.text());
      for (const el of $c(src.cards.item).toArray()) {
        const grp = $c(el).find(src.cards.group || "h3").first().text().replace(/[\s ]+/g, " ").trim();
        const sub = $c(el).find(src.cards.title || "p").first().text().replace(/[\s ]+/g, " ").trim();
        const title = [grp, sub].filter(Boolean).join(" ");
        const raw = $c(el).find(src.cards.link || "a[href]").first().attr("href");
        if (!title || !raw) continue;
        let url; try { url = new URL(raw, start).href; } catch { continue; }
        const key = normT(title);
        const id = crypto.createHash("sha1").update(src.id + key).digest("hex").slice(0, 12);
        if (seenId(id) || knownKeys.has(src.id + key)) continue;
        const dup = [...docs.values()].find(d => normT(d.title) === key);
        if (dup) { (dup.alsoIn ||= []).push({ dept: src.dept, url, srcKey: src.id + key }); knownKeys.add(src.id + key); continue; }
        // cards.download: ถ้าลิงก์ชี้ไปไฟล์ PDF บนเว็บหน่วยงานอื่น (และเปิดได้ตามปกติ) ดึงมาสกัดข้อความด้วย; ไม่ใช่ PDF/ถูกบล็อก = เก็บเป็นลิงก์
        let text = "", sha1 = "", size = 0, isLinkOnly = true;
        if (src.cards.download && new URL(url).host !== new URL(start).host) {
          const fr = await get(url);
          if (fr) {
            size = Number(fr.headers.get("content-length") || 0);
            if (/pdf/i.test(fr.headers.get("content-type") || "") && size <= S.max_pdf_mb * 1048576) {
              const buf = Buffer.from(await fr.arrayBuffer());
              sha1 = crypto.createHash("sha1").update(buf).digest("hex");
              try { text = await pdfText(buf); isLinkOnly = false; } catch (e) { console.log("  อ่าน PDF ไม่ได้:", e.message); }
            } else await fr.body?.cancel();
          }
        }
        const dupF = sha1 && [...docs.values()].find(d => d.sha1 === sha1 || (text.length > 200 && d.text === arabic(text)));
        if (dupF) { (dupF.alsoIn ||= []).push({ id, dept: src.dept, url, srcKey: src.id + key }); knownKeys.add(src.id + key); console.log(`  = ซ้ำกับ "${dupF.title.slice(0, 50)}" (${dupF.dept})`); continue; }
        console.log(`  + ${isLinkOnly ? "[ลิงก์]" : "[ไฟล์]"} ${title.slice(0, 60)}${isLinkOnly ? "" : `  (ข้อความ ${text.length} ตัวอักษร)`}`);
        docs.set(id, {
          id, title: arabic(title), sha1, srcKey: src.id + key,
          dept: src.dept, category: arabic(classify(title, src, grp)),
          tags: [...(src.default_tags || [])].map(arabic),
          year: thaiYear(title), status: "ใช้บังคับ",
          url, source: start, ...(isLinkOnly ? { linkOnly: true } : { sizeMB: Math.round(size / 104857.6) / 10 }),
          fetched: new Date().toISOString().slice(0, 10), text: arabic(text),
        });
        if (++n >= limit) break;
      }
    }
    return;
  }
  // odoo_slides_channel: ระบบ "คอร์ส/สไลด์" ของ Odoo — สไลด์ที่ติดป้าย Preview เปิดได้สาธารณะ ไฟล์จริงฝังจาก Google Drive
  // เก็บเป็นรายการลิงก์ (ชื่อ + หมวดจากหัวข้อกลุ่ม + ลิงก์ Drive) ไม่ดาวน์โหลดไฟล์; สไลด์ที่ต้องเป็นสมาชิก (เด้งกลับหน้าคอร์ส) ข้าม
  if (src.odoo_slides_channel) {
    const cr = await get(src.odoo_slides_channel);
    if (!cr) return;
    const $c = cheerio.load(await cr.text());
    const chBase = new URL(src.odoo_slides_channel);
    const rows = $c("li.o_wslides_slides_list_slide").toArray().map(li => {
      const a = $c(li).find("a[href*='/slides/slide/']").first();
      const cat = $c(li).closest("li.o_wslides_slide_list_category");
      return {
        sid: $c(li).attr("data-slide-id"),
        href: a.attr("href") ? new URL(a.attr("href"), chBase).href : "",
        title: a.text().replace(/[\s ]+/g, " ").trim(),
        group: cat.children("div").first().find("span").first().text().replace(/[\s ]+/g, " ").trim(),
      };
    }).filter(r => r.sid && r.href && r.title);
    console.log(`  พบสไลด์ ${rows.length} รายการ`);
    const normT = t => arabic(t).replace(/\s+/g, "").toLowerCase();
    let n = 0;
    for (const r of rows) {
      if (n >= limit) break;
      const key = "slide:" + r.sid;
      const id = crypto.createHash("sha1").update(src.id + key).digest("hex").slice(0, 12);
      if (seenId(id) || knownKeys.has(src.id + key)) continue;
      const pr = await get(r.href);
      if (!pr) continue;
      if (new URL(pr.url).pathname !== new URL(r.href).pathname) { console.log("  ข้าม (ต้องเป็นสมาชิก):", r.title.slice(0, 50)); await pr.body?.cancel(); continue; }
      const html = await pr.text();
      const driveId = (html.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || [])[1];
      const url = driveId ? `https://drive.google.com/file/d/${driveId}/view` : r.href;
      // ชื่อหรือไฟล์เดียวกับที่มีในคลังแล้ว (จากหน่วยอื่น/ดึงมาแล้ว) -> ไม่สร้างซ้ำ เก็บที่มาเป็น alsoIn
      const dup = [...docs.values()].find(d => d.url === url || normT(d.title) === normT(r.title));
      if (dup) {
        (dup.alsoIn ||= []).push({ dept: src.dept, url, srcKey: src.id + key });
        knownKeys.add(src.id + key);
        console.log(`  = ซ้ำกับ "${dup.title.slice(0, 50)}" (${dup.dept}) รวมเป็นรายการเดียว`);
        continue;
      }
      console.log(`  + [ลิงก์] ${r.title.slice(0, 60)}`);
      docs.set(id, {
        id, title: arabic(r.title), sha1: "", srcKey: src.id + key,
        dept: src.dept, category: arabic(classify(r.title, src, r.group)),
        tags: [...new Set([...(src.default_tags || []), ...(r.group && !src.group_is_category ? [r.group] : [])])].map(arabic),
        year: thaiYear(r.title), status: "ใช้บังคับ",
        url, source: r.href, linkOnly: true,
        fetched: new Date().toISOString().slice(0, 10), text: "",
      });
      n++;
    }
    return;
  }
  const found = new Map(); // key -> {href,text,page,pageTitle}
  // direct_files: [{url,title,group?}] — ไฟล์ที่ระบุที่อยู่ตรงๆ (เช่น ลิงก์ในเมนูที่ผู้ใช้ขอ) ผ่านขั้นตอนดาวน์โหลด/สกัดข้อความตามปกติ
  for (const d of src.direct_files || []) found.set(keyOf(d.url), { href: d.url, text: d.title, group: d.group || "", linkOnly: false, page: d.page || d.url, pageTitle: "" });
  // dir_index: หน้ารายการไฟล์ของเซิร์ฟเวอร์ (Apache "Index of /...") ไล่ลงโฟลเดอร์ย่อย (ลึกสุด 4 ชั้น)
  //   dir_title_from_folder: ชื่อเอกสาร = ชื่อโฟลเดอร์ที่ไฟล์อยู่ (ตัดเลขลำดับหน้าชื่อ) เหมาะกับไฟล์ชื่อ "1.pdf"; กลุ่ม = โฟลเดอร์ชั้นบนสุด
  if (src.dir_index) {
    const extRe = new RegExp("[.](pdf|docx?|xlsx?)$", "i");
    const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
    const walk = async (u, top, depth) => {
      const dr = await get(u);
      if (!dr) return;
      const $d = cheerio.load(await dr.text());
      for (const h of $d("a[href]").map((_, e) => $d(e).attr("href")).get()) {
        if (!h || h.startsWith("?") || h.startsWith("/") || /^https?:/.test(h)) continue;
        const full = new URL(h, u).href;
        const segs = dec(new URL(full).pathname).split("/").filter(Boolean);
        if (h.endsWith("/")) { if (depth < 4) await walk(full, top || dec(h).replace(/\/$/, ""), depth + 1); continue; }
        if (!extRe.test(dec(h))) continue;
        const folder = segs[segs.length - 2] || "";
        const titleFromFolder = folder.replace(/^[0-9.\s]+/, "").replace(/\s+/g, " ").trim();
        found.set(keyOf(full), { href: full, text: src.dir_title_from_folder ? titleFromFolder : "", group: top || "", linkOnly: false, page: u, pageTitle: titleFromFolder });
      }
    };
    for (const start of src.start_urls) await walk(start, "", 0);
    console.log(`  พบไฟล์ในรายการโฟลเดอร์ ${found.size} รายการ`);
  }
  for (const start of src.dir_index ? [] : (src.start_urls || [])) {
    const r = await get(start);
    if (!r) continue;
    const html0 = await r.text();
    const $ = cheerio.load(html0);
    const base = new URL(start);
    // title_strip: ตัดส่วนท้ายชื่อเว็บออกจากชื่อหน้า (เช่น " – กรมสื่อสารอิเล็กทรอนิกส์ทหารอากาศ")
    const pageTitle0 = $("title").text().replace(/\|.*$/, "").replace(src.title_strip ? new RegExp(src.title_strip) : /$^/, "").trim();
    for (const f of filesOnPage($, base, src)) {
      const k = keyOf(f.href), prev = found.get(k);
      if (!prev || (!prev.text && f.text)) found.set(k, { ...f, page: start, pageTitle: pageTitle0 });
    }
    // raw_file_regex: ไฟล์ที่ฝังด้วยปลั๊กอิน (เช่น embedpress) ไม่เป็นลิงก์ <a> — หาจากโค้ดหน้าเว็บ (ถอดรหัส %2F ก่อน) ชื่อ = ชื่อหน้า
    if (src.raw_file_regex) {
      let dec = html0.replace(/&#0?38;|&amp;/g, "&");
      try { dec = dec.replace(/(?:%[0-9A-Fa-f]{2})+/g, m => { try { return decodeURIComponent(m); } catch { return m; } }); } catch {}
      for (const m of dec.matchAll(new RegExp(src.raw_file_regex, "gi"))) {
        let href; try { href = new URL(m[0], base).href; } catch { continue; }
        const k = keyOf(href);
        if (!found.has(k)) found.set(k, { href, text: "", group: "", linkOnly: false, usePageTitle: true, page: start, pageTitle: pageTitle0 });
      }
    }
    // ตามลิงก์ไปหน้าย่อย (เฉพาะที่เลือกด้วย follow_selector)
    if (src.follow_selector) {
      const subs = new Set();
      $(src.follow_selector).each((_, a) => {
        const h = $(a).attr("href"); if (!h) return;
        const u = new URL(h, base);
        if ((src.allow_domains || []).some(d => u.hostname.endsWith(d)) && !/\/web\/(content|image)/.test(u.pathname)) subs.add(u.href.split("#")[0]);
      });
      for (const sub of [...subs].slice(0, src.max_pages || 50)) {
        const sr = await get(sub);
        if (!sr) continue;
        const $s = cheerio.load(await sr.text());
        const pageTitle = $s("title").text().replace(/\|.*$/, "").trim();
        for (const f of filesOnPage($s, new URL(sub), src)) {
          const k = keyOf(f.href);
          const prev = found.get(k);
          if (!prev || (!prev.text && f.text)) found.set(k, { ...f, page: sub, pageTitle });
        }
      }
    }
  }
  console.log(`  พบไฟล์ ${found.size} รายการ`);
  let n = 0;
  for (const [key, f] of found) {
    if (n >= limit) break;
    const id = crypto.createHash("sha1").update(src.id + key).digest("hex").slice(0, 12);
    if (seenId(id) || knownKeys.has(src.id + key)) continue;
    if (f.linkOnly) {
      // เก็บเป็นรายการลิงก์ ไม่ดาวน์โหลดไฟล์ (ไม่มีข้อความเนื้อหาให้ค้น ค้นได้จากชื่อ)
      const title = cleanTitle(f.text || f.pageTitle);
      console.log(`  + [ลิงก์] ${title.slice(0, 60)}`);
      docs.set(id, {
        id, title: arabic(title), sha1: "", srcKey: src.id + key,
        dept: src.dept,
        category: arabic(classify(title, src, f.group)),
        tags: [...new Set([...(src.default_tags || []), ...(f.group && f.group !== title ? [f.group] : [])])].map(arabic),
        year: thaiYear(title), status: "ใช้บังคับ",
        url: f.href, source: f.page, linkOnly: true,
        fetched: new Date().toISOString().slice(0, 10), text: "",
      });
      n++;
      continue;
    }
    // title_must_match: เอาเฉพาะชื่อ(หรือกลุ่ม)ที่ตรงนิพจน์นี้ เช่น "ระเบียบ|คำสั่ง|คู่มือ" — ตรวจก่อนดาวน์โหลดถ้ามีชื่อจากลิงก์แล้ว
    const mustRe = src.title_must_match ? new RegExp(src.title_must_match) : null;
    // must_match_exempt_url: ไฟล์ที่ผู้ใช้ระบุเองให้เอาแม้ชื่อไม่ตรงตัวกรอง (ตรงกับที่อยู่ไฟล์หลังถอดรหัส %)
    let exemptUrl = false; try { exemptUrl = !!(src.must_match_exempt_url && new RegExp(src.must_match_exempt_url).test(decodeURIComponent(f.href))); } catch {}
    if (mustRe && !exemptUrl && f.text && !mustRe.test(f.text + " " + (f.group || ""))) { console.log("  ข้าม (นอกขอบเขต):", f.text.slice(0, 50)); continue; }
    let head = await get(f.href);
    // บางเว็บลิงก์ชี้ /download/... แต่ไฟล์จริงอยู่ใต้ /new_web/download/...
    if (!head && /\/download\//.test(f.href) && !/\/new_web\//.test(f.href)) {
      const alt = f.href.replace("/download/", "/new_web/download/");
      head = await get(alt);
      if (head) { console.log("  (ใช้เส้นทางสำรอง /new_web)"); f.href = alt; }
    }
    if (!head) continue;
    const ctype = head.headers.get("content-type") || "";
    if (!/pdf|word|officedocument|ms-excel|spreadsheet/i.test(ctype)) { console.log("  ข้าม (ไม่ใช่เอกสาร):", ctype, f.href); await head.body?.cancel(); continue; }
    const fname = dispositionName(head.headers.get("content-disposition"));
    let title = f.text ? cleanTitle(f.text) : (cleanTitle(fname) || f.pageTitle);
    const size = Number(head.headers.get("content-length") || 0);
    let text = "", sha1 = "";
    if (size <= S.max_pdf_mb * 1048576) {
      const buf = Buffer.from(await head.arrayBuffer());
      // ไฟล์ที่เซิร์ฟเวอร์บอกว่าเป็น PDF แต่ข้อมูลจริงไม่มีหัว %PDF (เสีย/เข้ารหัส เปิดไม่ได้) -> ข้าม ไม่เก็บเข้าคลัง
      if (/pdf/i.test(ctype) && buf.length > 0 && !buf.subarray(0, 1024).toString("latin1").includes("%PDF")) { console.log("  ข้าม (ไม่ใช่ PDF จริง เปิดไม่ได้):", f.href.slice(-60)); continue; }
      sha1 = crypto.createHash("sha1").update(buf).digest("hex");
      if (/pdf/i.test(ctype)) { try { text = await pdfText(buf); } catch (e) { console.log("  อ่าน PDF ไม่ได้:", e.message); } }
    } else await head.body?.cancel();
    // title_from_pdf: ลิงก์ไม่มีข้อความชื่อ (เช่น การ์ดรูปปก) -> ใช้ชื่อไฟล์ใน URL ถ้ามีความหมาย ไม่งั้นใช้บรรทัดแรกๆ ของเอกสาร
    if (f.usePageTitle && f.pageTitle) title = cleanTitle(f.pageTitle); // ไฟล์ฝังในหน้า/โพสต์ ใช้ชื่อหน้าเป็นชื่อเอกสาร
    else if (src.title_from_pdf && !f.text) {
      let stem = "";
      try { stem = decodeURIComponent(new URL(f.href).pathname.split("/").pop()); } catch {}
      stem = stem.replace(/\.(pdf|docx?)$/i, "").replace(/^[a-z_]+-\d{8,}-/i, "").replace(/_o$/i, "").replace(/[_]+/g, " ").trim();
      const thaiLetters = (stem.match(/[ก-๙]/g) || []).length;
      if (thaiLetters >= 10 || stem.length >= 25) title = cleanTitle(stem);
      else {
        const lines = text.split("\n").map(l => l.replace(/[\s ]+/g, " ").trim()).filter(l => l.length >= 8);
        if (lines.length) title = lines.slice(0, 2).join(" ").slice(0, 110);
        else if (stem) title = cleanTitle(stem);
      }
    }
    if (mustRe && !exemptUrl && !mustRe.test(title + " " + (f.group || ""))) { console.log("  ข้าม (นอกขอบเขต):", title.slice(0, 50)); continue; }
    // ไฟล์เดียวกัน (เนื้อไฟล์เหมือนกัน) ที่พบจากหน่วยอื่น/หน้าอื่น -> เก็บแค่ฉบับแรก บันทึกที่มาอื่นไว้ใน alsoIn
    const dup = [...docs.values()].find(d => (sha1 && d.sha1 === sha1) || (text.length > 200 && d.text === arabic(text)));
    if (dup) {
      (dup.alsoIn ||= []).push({ dept: src.dept, url: f.href, srcKey: src.id + key });
      knownKeys.add(src.id + key);
      console.log(`  = ซ้ำกับ "${dup.title.slice(0, 50)}" (${dup.dept}) รวมเป็นรายการเดียว`);
      continue;
    }
    console.log(`  + ${title.slice(0, 60)}  (${(size / 1048576).toFixed(1)} MB, ข้อความ ${text.length} ตัวอักษร)`);
    docs.set(id, {
      id, title: arabic(title), sha1, srcKey: src.id + key,
      dept: src.dept,
      category: arabic(classify(title, src, f.group)),
      tags: [...new Set([...(src.default_tags || []), ...(f.group ? [f.group] : []), ...(!f.group && f.pageTitle && f.pageTitle !== title ? [f.pageTitle] : [])])].map(arabic),
      year: thaiYear(title) || thaiYear(text.slice(0, 800)),
      status: "ใช้บังคับ",
      url: f.href, source: f.page,
      sizeMB: Math.round(size / 104857.6) / 10,
      fetched: new Date().toISOString().slice(0, 10),
      text: arabic(text),
    });
    n++;
  }
}

const docs = new Map();
if (fs.existsSync(OUT)) {
  const j = JSON.parse(fs.readFileSync(OUT, "utf8"));
  for (const d of Array.isArray(j) ? j : j.docs) docs.set(d.id, d);
}
const knownKeys = new Set();
const knownIds = new Set(); // รหัสของรายการที่เคยถูกตัดซ้ำทิ้ง (กันดึงกลับมาใหม่ทุกรอบ)
const seenId = id => docs.has(id) || knownIds.has(id);
for (const d of docs.values()) { if (d.srcKey) knownKeys.add(d.srcKey); for (const a of d.alsoIn || []) { knownKeys.add(a.srcKey); if (a.id) knownIds.add(a.id); } }
for (const src of cfg.sources) {
  if (only ? src.id !== only : !src.enabled) { console.log("[ข้าม]", src.id); continue; }
  await crawlSource(src, docs);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), docs: [...docs.values()] }, null, 1));
console.log(`รวม ${docs.size} ฉบับ -> ${path.relative(ROOT, OUT)}`);
