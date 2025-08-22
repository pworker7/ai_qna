import fetch from "node-fetch";
import { readLastNFromLatestFile } from "./liveLog.mjs"; // No need for LOG_DIR here

/**
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL (optional, default: gemini-2.5-flash)
 *   - CHATROOM_IDS (space/newline/comma separated)
 *   - CONTEXT_CHANNEL_ID (optional, overrides)
 *   - GEMINI_DEBUG (1/true to enable verbose logs)
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!GEMINI_API_KEY) { throw new Error("GEMINI_API_KEY is not set"); }

const GEMINI_DEBUG = (process.env.GEMINI_DEBUG === "1" || (process.env.GEMINI_DEBUG || "").toLowerCase() === "true");
function glog(...a) { if (GEMINI_DEBUG) console.log("[askGemini]", ...a); }

const CHATROOM_IDS = (process.env.CHATROOM_IDS || "").split(/[\s,]+/).filter(Boolean);
const CONTEXT_CHANNEL_ID = process.env.CONTEXT_CHANNEL_ID || CHATROOM_IDS[0] || "";
const CONTEXT_LAST_N = 400;

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

function buildContext(records) {
    const arr = [...(records || [])];
    return arr.map(r => `- ${israelFormatShort(r.createdAt)} | ${r.author}: ${sanitizeContent(r.content)}`).join("\n");
}

function buildPrompt(userPrompt, context) {
    const systemPrompt = [
        "אתה עוזר חכם שמספק תשובות מדויקות ומועילות לשאלות משתמשים בהקשר של שיחות בדיסקורד.",
        "השתמש במידע מההודעות האחרונות כדי לספק תשובה רלוונטית, והשיב בעברית תוך שמירה על טון מקצועי ומכבד.",
        "אם אין מספיק מידע – אמור זאת בקצרה. רשום נקודות קצרות וברורות.",
        "הדגש tickers אם קיימים, ואזכור של חדשות אם ישנן."
    ].join("\n");

    const prompt = [
        systemPrompt, "",
        "### הקשר (הודעות אחרונות):",
        context || "אין הקשר זמין",
        "",
        `### שאלה: ${sanitizeContent(userPrompt, 300)}`,
        "",
        "נא להשיב בעברית קצר ותכליתי."
    ].join("\n");

    glog("prompt.chars:", prompt.length);
    return prompt;
}

async function getDateFromQuestion(userPrompt) {
    const now = new Date().toISOString().split("T")[0]; // Current date: 2025-08-18
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
    const bodyStr = JSON.stringify(body);

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: bodyStr
    });

    if (res.ok) {
        const json = await res.json();
        const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        glog("extracted date:", raw);
        // Validate date format
        const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dateMatch) {
            const extractedDate = new Date(raw);
            const minDate = new Date("2025-08-01"); // Arbitrary min date, adjust as needed
            const maxDate = new Date(); // Current date
            if (extractedDate >= minDate && extractedDate <= maxDate) {
                return raw; // Return valid date within range
            } else {
                glog("extracted date out of range, using current date:", now);
                return now;
            }
        }
    }
    // Fallback to current date if extraction fails
    glog("date extraction failed, using current date:", now);
    return now;
}

export async function askGemini(userPrompt) {
    try {
        const channelId = CONTEXT_CHANNEL_ID;
        glog("contextChannel:", channelId);

        // Step 1: Extract date from question
        const date = await getDateFromQuestion(userPrompt);

        // Step 2: Read context using readLastNFromLatestFile with the date
        const recentMessages = await readLastNFromLatestFile(channelId, CONTEXT_LAST_N, date);
        glog("records:", recentMessages.length);
        if (recentMessages[0]) glog("firstRec.ts:", recentMessages[0].createdAt);
        if (recentMessages.at(-1)) glog("lastRec.ts:", recentMessages.at(-1).createdAt);

        const prompt = buildPrompt(userPrompt, buildContext(recentMessages));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
        const body = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
        };
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