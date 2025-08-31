// cmd_handlers/monthlyScores.js
// SuperPony: Monthly Anonymous Score Collector
// Schedules: 29th @13:00 post window + @everyone; 14:00-17:00 hourly reminders; 18:00 publish average + delete window

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    Events,
    ModalBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const cron = require('node-cron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const dayjs = require('dayjs');
const utc = require('dayjs-plugin-utc');
const timezone = require('dayjs-plugin-timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = process.env.TIMEZONE || 'Asia/Jerusalem';
const SCORES_DIR = process.env.SCORES_DIR || path.join(process.cwd(), 'data', 'scores');
const STATE_DIR = path.join(process.cwd(), 'data', 'state');
const SECRET_SALT = process.env.SECRET_SALT || 'replace-me-with-a-very-long-random-secret';
const CHANNEL_ID = process.env.SCORE_CHANNEL_ID;
const GIT_COMMIT = process.env.GIT_COMMIT === '1';

const IDS = {
    BUTTON_OPEN_MODAL: 'monthly_scores_open_modal',
    MODAL_SUBMIT: 'monthly_scores_modal',
    INPUT_SCORE: 'monthly_scores_input',
};

function periodKey(date = dayjs().tz(TIMEZONE)) {
    return date.format('YYYY-MM'); // e.g., 2025-08
}

function ensureDirs() {
    if (!fs.existsSync(SCORES_DIR)) fs.mkdirSync(SCORES_DIR, { recursive: true });
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function scoresFileForPeriod(key) {
    return path.join(SCORES_DIR, `${key}.json`);
}

function stateFileForPeriod(key) {
    return path.join(STATE_DIR, `${key}.json`);
}

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
    if (GIT_COMMIT) tryGitCommit(file);
}

function tryGitCommit(filePath) {
    try {
        // Configure identity (safe to run repeatedly)
        if (process.env.GIT_USER_NAME) execSync(`git config user.name "${process.env.GIT_USER_NAME}"`, { stdio: 'ignore' });
        if (process.env.GIT_USER_EMAIL) execSync(`git config user.email "${process.env.GIT_USER_EMAIL}"`, { stdio: 'ignore' });

        execSync(`git add "${filePath}"`, { stdio: 'ignore' });
        const msg = `chore(scores): update ${path.relative(process.cwd(), filePath)} at ${new Date().toISOString()}`;
        execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
        // Optional: push if your repo expects it. Comment out if you prefer CI to push.
        try { execSync('git push', { stdio: 'ignore' }); } catch { }
    } catch (err) {
        // Silently ignore git errors to avoid crashing the bot
    }
}

function hashUserForPeriod(userId, pKey) {
    const h = crypto.createHmac('sha256', SECRET_SALT);
    h.update(`${pKey}:${userId}`);
    return h.digest('hex'); // anonymized, stable per period
}

function scoreEmbed() {
    return new EmbedBuilder()
        .setTitle('Monthly Anonymous Score')
        .setDescription('Click **Submit Score** to enter your number anonymously.\n\nYou will get a private confirmation (ephemeral).')
        .setColor(0x5865F2);
}

function scoreButtonRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(IDS.BUTTON_OPEN_MODAL)
            .setLabel('Submit Score')
            .setStyle(ButtonStyle.Primary)
    );
}

function scoreModal() {
    const modal = new ModalBuilder()
        .setCustomId(IDS.MODAL_SUBMIT)
        .setTitle('Submit Your Score');

    const input = new TextInputBuilder()
        .setCustomId(IDS.INPUT_SCORE)
        .setLabel('Enter a number (e.g., 87.5)')
        .setPlaceholder('Your score')
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

    return modal.addComponents(new ActionRowBuilder().addComponents(input));
}

async function postWindowAndPing(channel) {
    const pKey = periodKey();
    // Post @everyone ping + window message with button
    await channel.send({ content: '@everyone please report your score' });

    const msg = await channel.send({
        embeds: [scoreEmbed()],
        components: [scoreButtonRow()],
    });

    // Persist message id so we can delete it at 18:00
    await writeJSON(stateFileForPeriod(pKey), {
        channelId: channel.id,
        messageId: msg.id,
        createdAt: new Date().toISOString(),
    });

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
        // Clear state regardless of delete success
        await writeJSON(sfile, {});
    }
}

async function addScore(userId, rawScore, nowTz = dayjs().tz(TIMEZONE)) {
    const pKey = periodKey(nowTz);
    const file = scoresFileForPeriod(pKey);

    const scoreNum = Number(String(rawScore).replace(',', '.'));
    if (!Number.isFinite(scoreNum)) {
        throw new Error('Invalid number');
    }

    const data = await readJSON(file, { period: pKey, entries: [] });

    const fingerprint = hashUserForPeriod(userId, pKey);
    const already = data.entries.find(e => e.userHash === fingerprint);

    if (already) {
        // Overwrite their score for this period (lets user update if they re-open)
        already.score = scoreNum;
        already.updatedAt = new Date().toISOString();
    } else {
        data.entries.push({
            userHash: fingerprint,
            score: scoreNum,
            createdAt: new Date().toISOString(),
        });
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

function isTwentyNinth(dateTz) {
    return dateTz.date() === 29;
}

function registerSchedules(client) {
    // 29th @13:00 — Post the window + ping
    cron.schedule('0 13 29 * *', async () => {
        try {
            const now = dayjs().tz(TIMEZONE);
            if (!CHANNEL_ID) return;
            // guard for DST/timezone issues
            if (!isTwentyNinth(now)) return;

            const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) return;
            ensureDirs();
            await postWindowAndPing(channel);
        } catch (e) {
            // swallow errors to avoid crash
        }
    }, { timezone: TIMEZONE });

    // 29th @ 14:00-17:00 — hourly reminders
    cron.schedule('0 14-17 29 * *', async () => {
        try {
            const now = dayjs().tz(TIMEZONE);
            if (!CHANNEL_ID) return;
            if (!isTwentyNinth(now)) return;

            const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) return;
            await channel.send({ content: '@everyone please remember to fill your score' });
        } catch { }
    }, { timezone: TIMEZONE });

    // 29th @18:00 — publish average + delete window
    cron.schedule('0 18 29 * *', async () => {
        try {
            const now = dayjs().tz(TIMEZONE);
            if (!CHANNEL_ID) return;
            if (!isTwentyNinth(now)) return;

            const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) return;

            const pKey = periodKey(now);
            const avg = await computeAverageForPeriod(pKey);
            const text = (avg == null)
                ? '@everyone the group average score is: N/A (no submissions)'
                : `@everyone the group average score is: ${Number(avg.toFixed(2))}`;

            await channel.send({ content: text });

            // delete the window posted at 13:00 for this period
            await deleteWindowIfExists(client, pKey);
        } catch { }
    }, { timezone: TIMEZONE });
}

function registerInteractionHandlers(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            // Button -> open modal
            if (interaction.isButton() && interaction.customId === IDS.BUTTON_OPEN_MODAL) {
                await interaction.showModal(scoreModal());
                return;
            }

            // Modal submit -> validate & store score
            if (interaction.isModalSubmit() && interaction.customId === IDS.MODAL_SUBMIT) {
                const value = interaction.fields.getTextInputValue(IDS.INPUT_SCORE)?.trim();
                try {
                    await addScore(interaction.user.id, value, dayjs().tz(TIMEZONE));
                } catch (err) {
                    await interaction.reply({
                        content: '❌ Invalid number. Please try again with a numeric value (e.g., 87 or 87.5).',
                        ephemeral: true,
                    });
                    return;
                }

                await interaction.reply({
                    content: '✅ Your anonymous score has been recorded. Thank you!',
                    ephemeral: true,
                });
                return;
            }
        } catch (err) {
            try {
                if (interaction?.deferred || interaction?.replied) {
                    await interaction.followUp({ content: '⚠️ Something went wrong. Please try again.', ephemeral: true });
                } else {
                    await interaction.reply({ content: '⚠️ Something went wrong. Please try again.', ephemeral: true });
                }
            } catch { }
        }
    });
}

export function registerMonthlyScores(client) {
    if (!CHANNEL_ID) {
        console.warn('[monthlyScores] SCORE_CHANNEL_ID not set — handler disabled.');
        return;
    }
    ensureDirs();
    registerSchedules(client);
    registerInteractionHandlers(client);
    console.log('[monthlyScores] Registered monthly schedules and interaction handlers.');
}
