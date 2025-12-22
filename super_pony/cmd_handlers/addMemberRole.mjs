// addMemberRole.mjs
// ESM module for discord.js v14
// Replaces the old "!news register" flow with a BUTTON users can click to get the "member" role.
// Usage:
// 1) Admin posts the button message in a channel with:  !news post
// 2) Users click the button to receive the role.
//
// Environment variables:
// - LOBBY_CHANNEL_ID              (required) -> channel where the bot listens for the "!news post" admin command
// - MEMBER_ROLE_CHANNEL_ID      (optional) -> where the button message should be posted (defaults to LOBBY_CHANNEL_ID)
// - MEMBER_ROLE_ID              (optional) -> role ID (preferred if set)
// - MEMBER_ROLE_NAME            (optional) -> defaults to "member" (used if MEMBER_ROLE_ID not provided)
// - CMD_PREFIX                  (optional) -> defaults to "!"
// - MEMBER_ROLE_BUTTON_LABEL    (optional) -> defaults to "Get Member Role"

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} from "discord.js";

const LOBBY_CHANNEL_ID = process.env.LOBBY_CHANNEL_ID;
const MEMBER_ROLE_CHANNEL_ID = process.env.MEMBER_ROLE_CHANNEL_ID || LOBBY_CHANNEL_ID;

const MEMBER_ROLE_ID = (process.env.MEMBER_ROLE_ID || "").trim();
const MEMBER_ROLE_NAME = (process.env.MEMBER_ROLE_NAME || "member").trim();

const CMD_PREFIX = (process.env.CMD_PREFIX || "!").trim();
const BUTTON_LABEL = (process.env.MEMBER_ROLE_BUTTON_LABEL || "Get Member Role").trim();

const BUTTON_CUSTOM_ID = "member_role_claim_v1";

if (!LOBBY_CHANNEL_ID) {
  console.error("❌ Missing LOBBY_CHANNEL_ID env var (required).");
}

function normalize(str) {
  return (str || "").trim().toLowerCase();
}

async function resolveMemberRole(guild) {
  if (!guild) return null;

  // Prefer by ID
  if (MEMBER_ROLE_ID) {
    try {
      const byId = await guild.roles.fetch(MEMBER_ROLE_ID);
      if (byId) return byId;
    } catch {}
  }

  // Fallback by name (case-insensitive)
  await guild.roles.fetch(); // warm cache
  const byName =
    guild.roles.cache.find((r) => normalize(r.name) === normalize(MEMBER_ROLE_NAME)) ||
    null;

  return byName;
}

function buildRoleButtonRow() {
  const btn = new ButtonBuilder()
    .setCustomId(BUTTON_CUSTOM_ID)
    .setLabel(BUTTON_LABEL)
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(btn);
}

async function ensureBotCanManageRole({ guild, role }) {
  const me = guild.members.me || (await guild.members.fetchMe());

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      ok: false,
      msg: "❌ I need the **Manage Roles** permission to assign the role.",
    };
  }

  // Ensure role position is below the bot's highest role
  const myTop = me.roles.highest?.position ?? 0;
  if (role.position >= myTop) {
    return {
      ok: false,
      msg: "❌ My highest role must be above the target role. Please adjust role order.",
    };
  }

  return { ok: true, msg: "" };
}

/**
 * Call once on startup.
 * - Listens for:  !news post  (admin only) in LOBBY_CHANNEL_ID
 * - Listens for: button clicks (anywhere)
 */
export function registerAddMemeberRoleCmdHandler(client) {
  if (!client) throw new Error("registerAddMemeberRoleCmdHandler: client is required");

  // 1) Admin text command: post the button
  client.on("messageCreate", async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.guild) return; // no DMs
      if (message.channel?.type !== ChannelType.GuildText) return;
      if (message.channelId !== LOBBY_CHANNEL_ID) return;

      const content = normalize(message.content);
      console.log("Got message in lobby channel: ", content);
      if (!content.startsWith(normalize(CMD_PREFIX) + "news")) return;

      console.log("checking messahge is post");
      const parts = content.split(/\s+/g); // e.g., ["!news","post"]
      const cmd = parts[1] || "";
      if (cmd !== "post") return;

      // Only admins/mods can post the button message
      const member =
        message.member || (await message.guild.members.fetch(message.author.id));
      const isAllowed =
        member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        member.permissions.has(PermissionsBitField.Flags.ManageRoles);

      console.log("checking user is admin");
      if (!isAllowed) {
        await message.reply("❌ Only admins/mods can post the member-role button.");
        return;
      }

      console.log("checking channel this message was written in");
      const targetChannel =
        (MEMBER_ROLE_CHANNEL_ID &&
          (await message.guild.channels.fetch(MEMBER_ROLE_CHANNEL_ID).catch(() => null))) ||
        message.channel;

      if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await message.reply("❌ MEMBER_ROLE_CHANNEL_ID is invalid (must be a text channel).");
        return;
      }

      // Post the button
      const posted = await targetChannel.send({
        content: "Click the button to receive the **member** role:",
        components: [buildRoleButtonRow()],
        allowedMentions: { parse: [] },
      });

      // Reply with a clickable message link (you can paste this link anywhere)
      await message.reply(`✅ Posted. Message link: ${posted.url}`);
    } catch (err) {
      console.error("memberRoleButton (post) error:", err);
      try {
        await (message?.reply?.("⚠️ An error occurred. Ask an admin to check the logs.") ??
          Promise.resolve());
      } catch {}
    }
  });

  // 2) Button interaction: add the role
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      if (interaction.customId !== BUTTON_CUSTOM_ID) return;
      if (!interaction.guild) {
        await interaction.reply({ content: "❌ This only works inside a server.", ephemeral: true });
        return;
      }

      const role = await resolveMemberRole(interaction.guild);
      if (!role) {
        await interaction.reply({
          content:
            "❌ Could not find the role. Create a role named **member** (or set MEMBER_ROLE_ID / MEMBER_ROLE_NAME).",
          ephemeral: true,
        });
        return;
      }

      const can = await ensureBotCanManageRole({ guild: interaction.guild, role });
      if (!can.ok) {
        await interaction.reply({ content: can.msg, ephemeral: true });
        return;
      }

      const member =
        interaction.member ??
        (await interaction.guild.members.fetch(interaction.user.id));

      if (member.roles.cache.has(role.id)) {
        await interaction.reply({
          content: `✅ You already have **${role.name}**.`,
          ephemeral: true,
        });
        return;
      }

      await member.roles.add(role, "Self-assign via button");
      await interaction.reply({
        content: `✅ Added **${role.name}**.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("memberRoleButton (button) error:", err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "❌ Error handling the request.", ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: "❌ Error handling the request.", ephemeral: true }).catch(() => {});
      }
    }
  });
}


