import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

/**
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL (optional, default: gemini-2.5-flash-lite)
 *   - CHATROOM_IDS (space/newline/comma separated)
 *   - CONTEXT_CHANNEL_ID (optional, overrides)
 *   - GEMINI_DEBUG (1/true)
 *   - LOG_DIR (optional; defaults to GH runner path below)
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
if (!GEMINI_API_KEY) { throw new Error("GEMINI_API_KEY is not set"); }

const GEMINI_DEBUG = (process.env.GEMINI_DEBUG === "1" || (process.env.GEMINI_DEBUG || "").toLowerCase() === "true");
const LOG_DIR = process.env.LOG_DIR || "/home/runner/work/ai_qna/ai_qna/data/logs";

function glog(...a) { if (GEMINI_DEBUG) console.log("[askGemini]", ...a); }

// --- Gemini generic call ---
async function callGemini(model, apiKey, prompt, { temperature = 0.4, maxOutputTokens = 2048 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }]}], generationConfig: { temperature, maxOutputTokens } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(()=>"");
    const e = new Error(`Gemini HTTP ${res.status}: ${t.slice(0,400)}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  return text.trim();
}

// --- Dates extraction via Gemini ---
async function extractDatesArrayWithGemini(model, apiKey, userPrompt, tz = "Asia/Jerusalem") {
  const systemInstr = [
    "אתה ממפה פרומפט של משתמש לטווחי תאריכים מוחלטים.",
    "החזר JSON **בלבד** עם המפתח dates: רשימת מחרוזות תאריך בפורמט YYYY-MM-DD (ללא טווחים או טקסט נוסף).",
    "אם המשתמש ביקש 'השבוע', 'סוף השבוע', 'היומיים האחרונים', או כל טווח יחסי — המר לרשימת תאריכים (יום-יום) בשעון ישראל.",
    "דוגמה פלט חוקית:",
    '{"dates":["2025-08-18","2025-08-19","2025-08-20"]}'
  ].join("\n");

  const prompt = `${systemInstr}\n\nפרומפט משתמש:\n${userPrompt}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }]}], generationConfig: { temperature: 0.0, maxOutputTokens: 256 } };

  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini dates HTTP ${res.status}`);
  const data = await res.json();
  const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("")?.trim() || "{}";
  const jsonStart = txt.indexOf("{"), jsonEnd = txt.lastIndexOf("}");
  const json = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
  const dates = Array.isArray(json?.dates) ? json.dates : [];
  if (!dates.length) throw new Error("No dates returned by Gemini");
  glog("dates:", dates);
  return dates;
}

// --- Read logs for a specific YYYY-MM-DD ---
async function readLogsForDate(channelId, ymd) {
  const file = path.join(LOG_DIR, `${channelId}_${ymd}.jsonl`);
  let out = [];
  try {
    const txt = await fs.readFile(file, "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const text = obj.content?.trim?.() || obj.text?.trim?.() || obj.message?.trim?.() || "";
        if (!text) continue;
        out.push({ ts: obj.timestamp || obj.ts || 0, author: obj.author || obj.user || "Unknown", text });
      } catch {}
    }
  } catch {}
  out.sort((a,b)=> (a.ts||0)-(b.ts||0));
  return out;
}

// --- Main ---
export async function askGemini({ userPrompt, contextChannelId }) {
  try {
    if (!contextChannelId) throw new Error("Missing contextChannelId");

    // 1) get dates array via Gemini
    const dates = await extractDatesArrayWithGemini(GEMINI_MODEL, GEMINI_API_KEY, userPrompt, "Asia/Jerusalem");

    // 2) per-day summaries
    const perDaySummaries = [];
    for (const ymd of dates) {
      const msgs = await readLogsForDate(contextChannelId, ymd);
      if (msgs.length === 0) continue;

      const MAX = 15000;
      let acc = [], sum = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const s = `${msgs[i].author}: ${msgs[i].text}\n`;
        if (sum + s.length > MAX) break;
        acc.push(s); sum += s.length;
      }
      acc = acc.reverse();
      const dayContext = acc.join("");

      const dayPrompt = [
        `הקשר משיחות בתאריך ${ymd} (שעון ישראל).`,
        `ענה לשאלת המשתמש תוך סיכום נקודות חשובות, החלטות ומשימות, עם שמות/תאריכים/מספרים:`,
        userPrompt,
        "",
        "--- הקשר ---",
        dayContext
      ].join("\n");

      const dayAnswer = await callGemini(GEMINI_MODEL, GEMINI_API_KEY, dayPrompt);
      perDaySummaries.push({ ymd, text: dayAnswer || "" });
    }

    if (perDaySummaries.length === 0) {
      return `לא נמצאו הודעות לתאריכים שביקשת (${dates.join(", ")})`;
    }

    // 3) synthesize
    const synthPrompt = [
      "להלן סיכומי־יום לפי תאריך. סכם אותם לנקודות פעולה/החלטות/נושאים מרכזיים:",
      ...perDaySummaries.map(d => `### ${d.ymd}\n${d.text}`),
      "",
      "תן תוצר נקודתי, עם כותרות משנה קצרות, בלי חזרה מיותרת."
    ].join("\n");

    const final = await callGemini(GEMINI_MODEL, GEMINI_API_KEY, synthPrompt);
    return final || "לא התקבלה תשובת סיכום.";
  } catch (error) {
    console.error(`Error in askGemini:`, error);
    if (error.status === 429) return "❌ הגעת לגבול השאלות היומי של ג׳מיני. נסו שוב מאוחר יותר.";
    if (error.status === 400 && String(error.message).includes("maximum number of tokens")) {
      return "❌ השאלה ארוכה מדי. נסו טווח קצר יותר.";
    }
    return "❌ שגיאת Gemini.";
  }
}
