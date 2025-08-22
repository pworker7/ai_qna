import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs/promises";
import { readLastNFromLatestFile } from "./liveLog.mjs"; // No need for LOG_DIR here


/**
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL (optional, default: gemini-2.5-flash)
 *   - CHATROOM_IDS (space/newline/comma separated)
 *   - CONTEXT_CHANNEL_ID (optional, overrides)
 *   - GEMINI_DEBUG (1/true to enable verbose logs)
 *   - GEMINI_CACHE_DB_FILE (optional, default ./.gemini_cache.json)
 *   - GEMINI_CACHE_TTL (seconds, optional, default 14400 = 4h)
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!GEMINI_API_KEY) { throw new Error("GEMINI_API_KEY is not set"); }

const GEMINI_DEBUG = (process.env.GEMINI_DEBUG === "1" || (process.env.GEMINI_DEBUG || "").toLowerCase() === "true");
function glog(...a) { if (GEMINI_DEBUG) console.log("[askGemini]", ...a); }

const CHATROOM_IDS = (process.env.CHATROOM_IDS || "").split(/[\s,]+/).filter(Boolean);
const CONTEXT_CHANNEL_ID = process.env.CONTEXT_CHANNEL_ID || CHATROOM_IDS[0] || "";
const CONTEXT_LAST_N = 800;

// Israel-time formatter for prompt
const IL_TZ = "Asia/Jerusalem";
function israelFormatShort(iso) {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: IL_TZ, year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(d);
}

function sanitizeContent(s, max = 700) {
  return String(s || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---------- Cached Content plumbing ----------
const CACHE_DB_FILE = process.env.GEMINI_CACHE_DB_FILE || "./.gemini_cache.json";
const CACHE_TTL_SECONDS = parseInt(process.env.GEMINI_CACHE_TTL || "14400", 10); // 4h

async function loadCacheDB() {
  try { return JSON.parse(await fs.readFile(CACHE_DB_FILE, "utf8")); }
  catch { return { byHash: {} }; }
}
async function saveCacheDB(db) { await fs.writeFile(CACHE_DB_FILE, JSON.stringify(db, null, 2), "utf8"); }
function sha1(text) { return crypto.createHash("sha1").update(text).digest("hex"); }

async function ensureCachedChunk(text) {
  const hash = sha1(text);
  const db = await loadCacheDB();
  if (db.byHash[hash]?.name) return db.byHash[hash]; // { name, ts }

  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${GEMINI_API_KEY}`;
  const body = {
    model: GEMINI_MODEL,
    ttl: `${CACHE_TTL_SECONDS}s`,
    contents: [{ role: "user", parts: [{ text }] }]
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`cache.create failed ${res.status}: ${errText}`);
  }
  const json = await res.json();
  db.byHash[hash] = { name: json.name, ts: Date.now() };
  await saveCacheDB(db);
  return db.byHash[hash];
}

// ~800–1,200 tokens per chunk (rough proxy: 4 chars ≈ 1 token for Hebrew/English mix)
const TARGET_CHARS_PER_CHUNK = 4000; // ~1k tokens

function normalizeLine(r) {
  return `- ${israelFormatShort(r.createdAt)} | ${r.author}: ${sanitizeContent(r.content)}`;
}
function chunkRecords(records) {
  const lines = records.map(normalizeLine);
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    if ((buf + "\n" + line).length > TARGET_CHARS_PER_CHUNK && buf.length > 0) {
      chunks.push(buf.trim());
      buf = line;
    } else {
      buf = buf ? (buf + "\n" + line) : line;
    }
  }
  if (buf) chunks.push(buf.trim());
  return chunks;
}

// ---------- Prompts ----------
const SYSTEM_HE = [
  "אתה עוזר חכם המתמחה בניתוח שיחות ודאטה על שוק ההון בעברית.",
  "מטרה: תשובות קצרות, מקצועיות ומדויקות בהתבסס על ההקשר הנתון.",
  "הנחיות פלט:",
  "- הדגש TICKERS ב-**Bold** (למשל **TSLA**).",
  "- ציין חדשות/מאקרו/אירועים אם מופיעים.",
  "- סכם עמדות: מי תומך/מתנגד/נייטרלי, וציין משתמשים בסוגריים.",
  "- אם המידע חסר/סותר – אמור זאת במפורש.",
  "ענה בעברית בלבד, בנקודות קצרות וברורות."
].join("\n");

function buildGeminiBody({ cachedNames, deltaText, userPrompt }) {
  const contents = [];
  if (deltaText) {
    contents.push({
      role: "user",
      parts: [{ text: `### דלתא אחרונה (שורות חדשות):\n${deltaText}\n### סוף הדלתא` }]
    });
  }
  contents.push({
    role: "user",
    parts: [{ text: `### שאלה: ${sanitizeContent(userPrompt, 300)}\nנא להשיב בעברית קצר ותכליתי.` }]
  });
  return {
    model: GEMINI_MODEL,
    systemInstruction: { role: "user", parts: [{ text: SYSTEM_HE }] },
    cachedContents: cachedNames, // array of "cachedContents/..." IDs
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
  };
}

// ---------- Date extraction ----------
async function getDateFromQuestion(userPrompt) {
  const now = new Date().toISOString().split("T")[0];
  const datePrompt = [
    "אתה עוזר חכם שמנתח שאלות של משתמשים.",
    "בדוק את השאלה הבאה והחזר את התאריך המפורש או המרומז בה, בפורמט YYYY-MM-DD.",
    "התאריך הנוכחי הוא " + now + ", והאזור הזמני הוא Israel Daylight Time (IDT, UTC+3).",
    "אם יש מונחים יחסיים (כגון 'אתמול', 'לפני יומיים'), חשב את התאריך בהתבסס על התאריך הנוכחי (" + now + ") תוך שימוש באזור הזמני IDT.",
    "אם אין תאריך מפורש או מרומז, השתמש בתאריך הנוכחי כברירת מחדל.",
    "החזר רק את התאריך בפורמט YYYY-MM-DD.",
    "",
    `### שאלה: ${sanitizeContent(userPrompt, 300)}`
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: datePrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    glog("extracted date:", raw);
    const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
      const extractedDate = new Date(raw);
      const minDate = new Date("2025-08-01");
      const maxDate = new Date();
      if (extractedDate >= minDate && extractedDate <= maxDate) return raw;
      glog("extracted date out of range, using current date:", now);
      return now;
    }
  }
  glog("date extraction failed, using current date:", now);
  return now;
}

// ---------- Main ----------
export async function askGemini(userPrompt) {
  try {
    const channelId = CONTEXT_CHANNEL_ID;
    glog("contextChannel:", channelId);

    // 1) Date
    const date = await getDateFromQuestion(userPrompt);

    // 2) Context
    const recentMessages = await readLastNFromLatestFile(channelId, CONTEXT_LAST_N, date);
    glog("records:", recentMessages.length);
    if (recentMessages[0]) glog("firstRec.ts:", recentMessages[0].createdAt);
    if (recentMessages.at(-1)) glog("lastRec.ts:", recentMessages.at(-1).createdAt);

    // 3) Chunk + cache
    const chunks = chunkRecords(recentMessages);
    const cached = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      const info = await ensureCachedChunk(chunks[i]);
      cached.push(info.name);
    }
    const deltaText = chunks.length ? chunks[chunks.length - 1] : "";

    // 4) Ask Gemini with cachedContents
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
    const body = buildGeminiBody({ cachedNames: cached, deltaText, userPrompt });
    const bodyStr = JSON.stringify(body);
    console.log("askGemini.body:", bodyStr);
    glog("http.body.bytes:", Buffer.byteLength(bodyStr, "utf8"));

    let finalText = "לא מצאתי תשובה רלוונטית לשאלה שלךת. נסו לשאול שאלה אחרת או לספק נתונים נוספים.";

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: bodyStr
      });
      glog("http.status:", res.status);

      if (res.ok) {
        const json = await res.json().catch(e => { glog("json.parse.error", e?.message); return null; });
        glog("resp.hasCandidates:", !!json?.candidates, "resp.len.bytes:", Buffer.byteLength(JSON.stringify(json || {}), "utf8"));

        const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        glog("raw.answer.chars:", raw.length, "preview:", raw);

        finalText = (raw.trim() || "לא מצאתי מידע רלוונטי בשיחה שהתקיימה בחדר בזמן הזה, אולי צריך לשאול על שעות אחרות או יום אחר.");
      } else {
        const errText = await res.text();
        glog("http.error:", res.status, errText);
        throw Object.assign(new Error(`Gemini API error ${res.status}: ${errText}`), { status: res.status });
      }
    } catch (e) {
      if (e.status === 429 || e.code === "RESOURCE_EXHAUSTED") {
        finalText = "❌ הגעת לגבול השאלות היומי של ג'מיני. נסו שוב מאוחר יותר.";
      }
      if (e.status === 400 && String(e.message).includes("exceeds the maximum number of tokens")) {
        finalText = "❌ השאלה ארוכה מדי. נסו לשאול שאלה קצרה יותר, או לשאול על פרק זמן קצר יותר (כמו השעה האחרונה, או היום האחרון).";
      }
    }

    glog("finalText.chars:", finalText.length, "preview:", finalText.slice(0, 180).replace(/\n/g, " "));
    return finalText;
  } catch (error) {
    console.error(`Error in askGemini for prompt "${userPrompt}":`, error.message);
    return "❌ שגיאת Gemini.";
  }
}
