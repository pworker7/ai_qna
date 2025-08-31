// cmd_handlers/monthlyScores_webhookTriggers.js
// SuperPony: Monthly Anonymous Score Collector (Webhook-triggered, separate LOG channel)
// Triggers (sent by a Discord channel webhook into LOG_CHANNEL_ID):
//   - "sp:scores:start [period=YYYY-MM] token=XXXX"   -> posts @everyone + score window (in SCORE_CHANNEL_ID)
//   - "sp:scores:remind token=XXXX"                   -> posts @everyone reminder (in SCORE_CHANNEL_ID)
//   - "sp:scores:publish [period=YYYY-MM] token=XXXX" -> posts average + deletes window (in SCORE_CHANNEL_ID)
//
// Security: requires message.webhookId (i.e., came from a webhook) AND a token match in content.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    Events,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

import { commitLogIfChanged } from '../../utils/liveLog.mjs';


dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = process.env.TIMEZONE || 'Asia/Jerusalem';
const SCORES_DIR = process.env.SCORES_DIR || path.join(process.cwd(), 'data', 'scores');
const STATE_DIR = path.join(process.cwd(), 'data', 'state');
const SECRET_SALT = process.env.SECRET_SALT || 'mkld4Rfvl0BYjn4SF5lk9jF3WcY';
const SCORE_CHANNEL_ID = process.env.SCORE_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const SCORES_TRIGGER_TOKEN = process.env.SCORES_TRIGGER_TOKEN || '';

const IDS = {
    BUTTON_OPEN_MODAL: 'monthly_scores_open_modal',
    MODAL_SUBMIT: 'monthly_scores_modal',
    INPUT_SCORE: 'monthly_scores_input',
};

function ensureDirs() {
    if (!fs.existsSync(SCORES_DIR)) fs.mkdirSync(SCORES_DIR, { recursive: true });
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function periodKey(date = dayjs().tz(TIMEZONE)) {
    return date.format('YYYY-MM'); // e.g., 2025-08
}
function scoresFileForPeriod(key) { return path.join(SCORES_DIR, `${key}.json`); }
function stateFileForPeriod(key) { return path.join(STATE_DIR, `${key}.json`); }

async function readJSON(file, fallback) {
    try {
        const txt = await fsp.readFile(file, 'utf8');
        return JSON.parse(txt);
    } catch {
        return fallback;
    }
}
async function writeJSON(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    await commitLogIfChanged(file);
}

function hashUserForPeriod(userId, pKey) {
    const h = crypto.createHmac('sha256', SECRET_SALT);
    h.update(`${pKey}:${userId}`);
    return h.digest('hex');
}

function scoreEmbed() {
    return new EmbedBuilder()
        .setTitle('תשואה חודשית - סקר אנונימי')
        .setDescription('לחצו "**השתתפו בסקר**" כדי שנחשב גם את התשואה שלכם בסקר.\n\nתקבלו חלונית הזנה פרטית שרק אתם רואים אותה,\nאף פרט אישי עליכם לא נשמר, גם לא בלוגים.\nאין דרך לדעת מי מגיש את התשואה, לא למפתח ולא לבוט וגם לא למנהלי השרת.')
        .setColor(0x57F287);
}
function scoreButtonRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.BUTTON_OPEN_MODAL).setLabel('השתתפו בסקר').setStyle(ButtonStyle.Success)
    );
}
function scoreModal() {
    const modal = new ModalBuilder().setCustomId(IDS.MODAL_SUBMIT).setTitle('הגישו את אחוז התשואה החודשית שלכם');
    console.log('[DEBUG] Creating modal with ID:', IDS.MODAL_SUBMIT);
    const input = new TextInputBuilder()
        .setCustomId(IDS.INPUT_SCORE)
        .setLabel('הקלידו את אחוז התשואה החודשית בתיק שלכם כמספר בלבד\n(ללא סימן אחוז, ניתן לסמן פלוס או מינוס)\nלדוגמה: 87.5 או 5.1-')
        .setPlaceholder('אחוז התשואה שלי החודש')
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
    console.log('[DEBUG] Created text input with ID:', IDS.INPUT_SCORE);
    return modal.addComponents(new ActionRowBuilder().addComponents(input));
}

// --- Actions in SCORE CHANNEL -------------------------------------------------

async function getScoreChannel(client) {
    if (!SCORE_CHANNEL_ID) return null;
    const channel = await client.channels.fetch(SCORE_CHANNEL_ID).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    return channel;
}

async function postWindowAndPing(scoreChannel, nowTz) {
    const pKey = periodKey(nowTz);
    await scoreChannel.send({ content: '@every one הגיע הזמן הזה בחודש ... השתתפו בסקר התשואה האנונימי החודשי של השרת' });
    const msg = await scoreChannel.send({ embeds: [scoreEmbed()], components: [scoreButtonRow()] });
    await writeJSON(stateFileForPeriod(pKey), { channelId: scoreChannel.id, messageId: msg.id, createdAt: new Date().toISOString() });
    return msg.id;
}

async function deleteWindowIfExists(client, pKey) {
    const sfile = stateFileForPeriod(pKey);
    const state = await readJSON(sfile, null);
    if (!state) return;
    try {
        const channel = await client.channels.fetch(state.channelId);
        if (channel && channel.type === ChannelType.GuildText) {
            const message = await channel.messages.fetch(state.messageId).catch(() => null);
            if (message) await message.delete().catch(() => { });
        }
    } finally {
        await writeJSON(sfile, {}); // clear state
    }
}

async function addScore(userId, rawScore, nowTz = dayjs().tz(TIMEZONE)) {
    const pKey = periodKey(nowTz);
    const file = scoresFileForPeriod(pKey);
    const scoreNum = Number(String(rawScore).replace(',', '.').replace('%', '').replace('+', '').trim());
    if (!Number.isFinite(scoreNum)) throw new Error('הערך שהזנתם אינו מספר תקין, אנא נסו שוב');

    const data = await readJSON(file, { period: pKey, entries: [] });
    const fingerprint = hashUserForPeriod(userId, pKey);
    const existing = data.entries.find(e => e.userHash === fingerprint);

    if (existing) {
        existing.score = scoreNum;
        existing.updatedAt = new Date().toISOString();
    } else {
        data.entries.push({ userHash: fingerprint, score: scoreNum, createdAt: new Date().toISOString() });
    }
    await writeJSON(file, data);
}

async function computeAverageForPeriod(pKey) {
    const file = scoresFileForPeriod(pKey);
    const data = await readJSON(file, null);
    if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return null;
    const sum = data.entries.reduce((acc, e) => acc + Number(e.score || 0), 0);
    return sum / data.entries.length;
}

// ---- Trigger Parsing & Guards ------------------------------------------------

function parseTriggerContent(contentRaw) {
    // Accepts:
    //   "sp:scores:start token=XYZ"
    //   "sp:scores:start period=2025-08 token=XYZ"
    //   "sp:scores:remind token=XYZ"
    //   "sp:scores:publish token=XYZ"
    const content = (contentRaw || '').trim();
    const lower = content.toLowerCase();

    let type = null;
    if (lower.startsWith('sp:scores:start')) type = 'start';
    else if (lower.startsWith('sp:scores:remind')) type = 'remind';
    else if (lower.startsWith('sp:scores:publish')) type = 'publish';
    else return null;

    const args = {};
    const parts = content.split(/\s+/);
    for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split('=');
        if (k && v) args[k.trim()] = v.trim();
    }
    return { type, args };
}

function tokenIsValid(args) {
    if (!SCORES_TRIGGER_TOKEN) return false;
    return (args?.token === SCORES_TRIGGER_TOKEN);
}

// ---- Registration ------------------------------------------------------------

function registerInteractionHandlers(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isButton() && interaction.customId === IDS.BUTTON_OPEN_MODAL) {
                console.log(`[DEBUG] Button clicked by ${interaction.user.tag}, attempting to show modal`);                
                await interaction.showModal(scoreModal());
                console.log(`[DEBUG] Modal shown successfully for ${interaction.user.tag}`);
                return;
            }
            if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL_SUBMIT) {
                console.log(`[DEBUG] Modal submitted by ${interaction.user.tag}`);                
                const value = interaction.fields.getTextInputValue(IDS.INPUT_SCORE)?.trim();
                try {
                    await addScore(interaction.user.id, value, dayjs().tz(TIMEZONE));
                } catch {
                    await interaction.reply({ content: '❌ הערך שהזנתם אינו מספר תקין, אנא נסו שוב (לדוגמה:87.5 או 5.1-).', ephemeral: true });
                    return;
                }
                await interaction.reply({ content: '✅ הערך שהזנת נשמר באופן אנונימי ופרטי, תודה לך על השתתפותך בסקר\nבתום איסוף הנתונים יפורסם ממוצי התשואה בשרת לכולם', ephemeral: true });
            }
        } catch {
            console.error(`[ERROR] InteractionCreate failed for ${interaction.user.tag}:`, err);
            try {
                if (interaction?.deferred || interaction?.replied) {
                    await interaction.followUp({ content: '⚠️ משהו השתבש, אנא נסו שוב.', ephemeral: true });
                } else {
                    await interaction.reply({ content: '⚠️ משהו השתבש, אנא נסו שוב.', ephemeral: true });
                }
            } catch(followUpErr) {
                console.error(`[ERROR] Failed to send follow-up/reply for ${interaction.user.tag}:`, followUpErr);                
            }
        }
    });
}

function registerWebhookTriggerListener(client) {
    client.on(Events.MessageCreate, async (msg) => {
        try {
            // Must arrive in the LOG channel from a webhook
            if (msg.webhookId) {
                if (msg.channel.id === LOG_CHANNEL_ID) {
                    const parsed = parseTriggerContent(msg.content);
                    console.log('[monthlyScoresWebhook] Parsed trigger:', parsed);
                    if (!parsed) return;
                    if (!tokenIsValid(parsed.args)) {
                        await msg.reply({ content: '❌ Invalid or missing token.', allowedMentions: { parse: [] } }).catch(() => { });
                        return;
                    }

                    const nowTz = dayjs().tz(TIMEZONE);
                    const pKey = parsed.args.period || periodKey(nowTz);

                    const scoreChannel = await getScoreChannel(client);
                    if (!scoreChannel) {
                        await msg.reply({ content: '⚠️ SCORE_CHANNEL_ID is not a valid text channel.', allowedMentions: { parse: [] } }).catch(() => { });
                        return;
                    }

                    if (parsed.type === 'start') {
                        await postWindowAndPing(scoreChannel, nowTz);
                        await msg.react('✅').catch(() => { });
                    } else if (parsed.type === 'remind') {
                        await scoreChannel.send({ content: '@every one מזכיר לכם שהיום מתקיים סקר תשואה חודשית אנונימי, אתם מוזמנים להשתתף ולהגיש את המספר שלכם, הסקר אנונימי לחלוטין' });
                        await msg.react('⏰').catch(() => { });
                    } else if (parsed.type === 'publish') {
                        const avg = await computeAverageForPeriod(pKey);
                        const text = (avg == null)
                            ? '@every one התשואה הממוצעת לקבוצה שהשתתפה בסקר היא: 0% (אף אחד לא השתתף בסקר)'
                            : `@every one התשואה הממוצעת לקבוצה שהשתתפה בסקר היא: ${Number(avg.toFixed(2))}`;
                        await scoreChannel.send({ content: text });
                        await deleteWindowIfExists(client, pKey);
                        await msg.react('📊').catch(() => { });
                    }
                }
            }
        } catch {
            // no-op; avoid crashing the bot on webhook mishaps
        }
    });
}

export function registerMonthlyScores(client) {
    if (!SCORE_CHANNEL_ID) {
        console.warn('[monthlyScoresWebhook] SCORE_CHANNEL_ID not set — handler disabled.');
        return;
    }
    if (!LOG_CHANNEL_ID) {
        console.warn('[monthlyScoresWebhook] LOG_CHANNEL_ID not set — handler disabled.');
        return;
    }
    if (!SCORES_TRIGGER_TOKEN) {
        console.warn('[monthlyScoresWebhook] SCORES_TRIGGER_TOKEN not set — REFUSING to run for safety.');
        return;
    }
    ensureDirs();
    registerInteractionHandlers(client);
    registerWebhookTriggerListener(client);
    console.log('[monthlyScoresWebhook] Registered webhook trigger listener (LOG channel) and interaction handlers.');
}