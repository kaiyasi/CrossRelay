const { ChannelType } = require("discord.js");
const logger = require("./logger");

let discordClient = null;

function init(client) {
  discordClient = client;
}

// ─── Sender / attachment helpers ──────────────────────────────────────────────

function getDiscordSenderName(message) {
  const userName = message.member?.displayName || message.author?.globalName || message.author?.username || "Discord User";
  const serverName = message.guild?.name;
  if (serverName && serverName !== userName) return `${serverName} | ${userName}`;
  return userName;
}

function getDiscordSenderAvatarUrl(message) {
  return message.member?.displayAvatarURL({ size: 128 }) || message.author?.displayAvatarURL({ size: 128 }) || null;
}

function getDiscordForwardSnapshot(message) {
  if (!message?.messageSnapshots) return null;

  if (typeof message.messageSnapshots.values === "function") {
    const iter = message.messageSnapshots.values();
    const first = iter.next();
    return first.done ? null : first.value;
  }

  if (Array.isArray(message.messageSnapshots)) {
    return message.messageSnapshots[0] || null;
  }

  return null;
}

function getDiscordMessageText(message) {
  const text = resolveDiscordMentions(message).trim();
  if (text) return text;

  const snapshot = getDiscordForwardSnapshot(message);
  const snapshotText = normalizeDiscordSpecialTokens(String(snapshot?.content || "")).trim();
  if (snapshotText) return snapshotText;

  return "";
}

function extractCustomEmojiAttachments(content) {
  const out = [];
  const text = String(content || "");
  const regex = /<(a)?:([a-zA-Z0-9_]+):(\d+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const animated = Boolean(match[1]);
    const name = match[2] || "emoji";
    const id = match[3];
    const ext = animated ? "gif" : "png";
    out.push({
      url: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
      name: `${name}.${ext}`,
      contentType: animated ? "image/gif" : "image/png"
    });
  }
  return out;
}

function getDiscordAttachments(message) {
  const out = Array.from(message.attachments.values()).map((attachment) => ({
    url: attachment.url,
    name: attachment.name || "attachment",
    contentType: attachment.contentType || ""
  }));

  out.push(...extractCustomEmojiAttachments(message.content || ""));

  const snapshot = getDiscordForwardSnapshot(message);
  out.push(...extractCustomEmojiAttachments(snapshot?.content || ""));
  if (snapshot?.attachments && typeof snapshot.attachments.values === "function") {
    for (const attachment of snapshot.attachments.values()) {
      out.push({
        url: attachment.url,
        name: attachment.name || "attachment",
        contentType: attachment.contentType || ""
      });
    }
  }

  if (Array.isArray(snapshot?.embeds)) {
    for (const embed of snapshot.embeds) {
      if (embed?.url) {
        out.push({ url: embed.url, name: "embed", contentType: "" });
      }
    }
  }

  const seen = new Set();
  return out.filter((item) => {
    if (!item?.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function getDiscordStickers(message) {
  if (!message.stickers || message.stickers.size === 0) return [];
  return Array.from(message.stickers.values())
    .map((sticker) => ({ url: sticker.url, name: sticker.name || "sticker" }))
    .filter((sticker) => sticker.url);
}

/**
 * Resolve Discord mention tokens in message.content to plain @name / #name text.
 * <@USER_ID>, <@!USER_ID> → @displayName
 * <@&ROLE_ID>             → @roleName
 * <#CHANNEL_ID>           → #channelName
 */
function resolveDiscordMentions(message) {
  let content = message.content || "";

  content = content.replace(/<@!?(\d+)>/g, (_, userId) => {
    const member = message.mentions.members?.get(userId);
    if (member) return `@${member.displayName}`;
    const user = message.mentions.users?.get(userId);
    if (user) return `@${user.globalName || user.username}`;
    return `@${userId}`;
  });

  content = content.replace(/<@&(\d+)>/g, (_, roleId) => {
    const role = message.mentions.roles?.get(roleId);
    return role ? `@${role.name}` : "@role";
  });

  content = content.replace(/<#(\d+)>/g, (_, channelId) => {
    const channel = message.mentions.channels?.get(channelId);
    return channel ? `#${channel.name}` : "#channel";
  });

  return normalizeDiscordSpecialTokens(content);
}

function normalizeDiscordSpecialTokens(content) {
  let out = String(content || "");
  // Custom emojis: <:name:id> or <a:name:id> -> remove from text (image is sent separately)
  out = out.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, "");
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

// ─── Webhook management ───────────────────────────────────────────────────────

async function ensureDiscordRelayWebhook(channel) {
  if (!channel || !channel.isTextBased() || typeof channel.fetchWebhooks !== "function") {
    return null;
  }

  try {
    const webhooks = await channel.fetchWebhooks();
    const existing = webhooks.find(
      (hook) => hook.owner?.id === discordClient.user?.id && hook.name === "TG Bridge Relay"
    );
    if (existing) return existing;

    if (typeof channel.createWebhook !== "function") return null;

    return await channel.createWebhook({ name: "TG Bridge Relay" });
  } catch (error) {
    logger.warn("Webhook unavailable, fallback to normal bot messages:", error.message || error);
    return null;
  }
}

// ─── Send / edit / delete ─────────────────────────────────────────────────────

function buildDiscordUploadFiles(mediaFiles = []) {
  return mediaFiles
    .filter((file) => file?.buffer && file?.name)
    .map((file) => ({ attachment: file.buffer, name: file.name }));
}

function buildTelegramToDiscordContent({ textContent, mediaUrls, mediaFiles = [], stickerEmoji }) {
  const blocks = [];
  if (textContent && textContent.trim()) blocks.push(textContent.trim());
  // Keep URLs only for media that could not be uploaded durably.
  const uploadedUrls = new Set(mediaFiles.map((file) => file.url).filter(Boolean));
  const fallbackUrls = mediaUrls.filter((url) => !uploadedUrls.has(url));
  if (fallbackUrls.length > 0) blocks.push(fallbackUrls.join("\n"));
  // Only show emoji fallback when no media URL was resolved (e.g. animated sticker with no thumbnail)
  if (stickerEmoji && mediaUrls.length === 0 && mediaFiles.length === 0) blocks.push(`Sticker: ${stickerEmoji}`);
  return blocks.join("\n\n").trim();
}

/**
 * Send a Telegram message to Discord via the bridge's webhook or channel.
 * Webhooks don't support reply threading, so replies always use channel.send.
 */
async function sendTelegramToDiscord({ senderName, senderAvatarUrl, textContent, mediaUrls, mediaFiles = [], stickerEmoji, replyToDiscordMessageId = null, bridge }) {
  const content = buildTelegramToDiscordContent({ textContent, mediaUrls, mediaFiles, stickerEmoji });
  const files = buildDiscordUploadFiles(mediaFiles);
  if (!content && files.length === 0) return null;
  const fileOptions = files.length > 0 ? { files } : {};

  // Use webhook when available and no reply is needed
  if (bridge.discordWebhook && !replyToDiscordMessageId) {
    try {
      const sent = await bridge.discordWebhook.send({
        content,
        ...fileOptions,
        username: senderName.slice(0, 80),
        avatarURL: senderAvatarUrl || undefined,
        allowedMentions: { parse: [] }
      });
      return { id: sent.id, viaWebhook: true, savedAt: Date.now() };
    } catch (error) {
      logger.warn("Webhook send failed, attempting webhook refresh:", error.message || error);
      bridge.discordWebhook = await ensureDiscordRelayWebhook(bridge.discordChannel);
      if (bridge.discordWebhook) {
        try {
          const sent = await bridge.discordWebhook.send({
            content,
            ...fileOptions,
            username: senderName.slice(0, 80),
            avatarURL: senderAvatarUrl || undefined,
            allowedMentions: { parse: [] }
          });
          return { id: sent.id, viaWebhook: true, savedAt: Date.now() };
        } catch (retryError) {
          logger.warn("Webhook retry also failed, falling back to channel message:", retryError.message || retryError);
        }
      }
    }
  }

  const sendOptions = {
    content: `**${senderName}**\n${content}`,
    ...fileOptions,
    allowedMentions: { parse: [], repliedUser: false }
  };

  if (replyToDiscordMessageId) {
    try {
      const sent = await bridge.discordChannel.send({
        ...sendOptions,
        reply: { messageReference: replyToDiscordMessageId }
      });
      return { id: sent.id, viaWebhook: false, savedAt: Date.now() };
    } catch (_replyError) {
      logger.warn("Discord reply send failed (message may have been deleted), sending without reply");
    }
  }

  try {
    const sent = await bridge.discordChannel.send(sendOptions);
    return { id: sent.id, viaWebhook: false, savedAt: Date.now() };
  } catch (error) {
    if (files.length === 0) throw error;
    logger.warn("Discord media upload failed, retrying with Telegram URLs:", error.message || error);
    const fallbackContent = buildTelegramToDiscordContent({ textContent, mediaUrls, mediaFiles: [], stickerEmoji });
    const fallbackOptions = {
      content: `**${senderName}**\n${fallbackContent}`,
      allowedMentions: { parse: [], repliedUser: false }
    };
    if (replyToDiscordMessageId) fallbackOptions.reply = { messageReference: replyToDiscordMessageId };
    const sent = await bridge.discordChannel.send(fallbackOptions);
    return { id: sent.id, viaWebhook: false, savedAt: Date.now() };
  }
}

async function editTelegramToDiscordMessage(relay, { senderName, textContent, mediaUrls, mediaFiles = [], stickerEmoji, bridge }) {
  const content = buildTelegramToDiscordContent({ textContent, mediaUrls, mediaFiles, stickerEmoji });
  if (!relay || (!content && mediaFiles.length === 0)) return;
  const files = buildDiscordUploadFiles(mediaFiles);
  const fileOptions = files.length > 0 ? { files } : {};

  if (relay.viaWebhook && bridge.discordWebhook) {
    await bridge.discordWebhook.editMessage(relay.id, {
      content,
      ...fileOptions,
      allowedMentions: { parse: [] }
    });
    return;
  }

  const message = await bridge.discordChannel.messages.fetch(relay.id);
  await message.edit({
    content: `**${senderName}**\n${content}`,
    ...fileOptions,
    allowedMentions: { parse: [] }
  });
}

async function deleteDiscordRelayMessage(relay, bridge) {
  if (!relay) return;

  try {
    if (relay.viaWebhook && bridge.discordWebhook) {
      await bridge.discordWebhook.deleteMessage(relay.id);
      return;
    }
    const message = await bridge.discordChannel.messages.fetch(relay.id);
    await message.delete();
  } catch (error) {
    logger.warn("Unable to delete Discord relay message:", error.message || error);
  }
}

// ─── Discord → Discord relay ──────────────────────────────────────────────────

/**
 * Build relay content for DC→DC: resolved text + attachment URLs + sticker URLs.
 * Discord auto-embeds image/video URLs so bare URLs are all we need.
 */
function buildDiscordRelayContent(message) {
  const parts = [];
  const text = getDiscordMessageText(message);
  if (text) parts.push(text);
  const attachmentUrls = getDiscordAttachments(message).map((a) => a.url);
  if (attachmentUrls.length > 0) parts.push(attachmentUrls.join("\n"));
  const stickerUrls = message.stickers
    ? Array.from(message.stickers.values()).map((s) => s.url).filter(Boolean)
    : [];
  if (stickerUrls.length > 0) parts.push(stickerUrls.join("\n"));
  return parts.join("\n\n").trim();
}

/**
 * Relay a Discord message to another Discord channel (DC→DC within a group).
 * Uses webhook when available; falls back to channel.send with bold sender header.
 */
async function relayDiscordToDiscord({ senderName, senderAvatarUrl, content, sink }) {
  if (!content) return null;

  if (sink.discordWebhook) {
    try {
      const sent = await sink.discordWebhook.send({
        content,
        username: senderName.slice(0, 80),
        avatarURL: senderAvatarUrl || undefined,
        allowedMentions: { parse: [] }
      });
      return { relayId: sent.id, viaWebhook: true, savedAt: Date.now() };
    } catch (error) {
      logger.warn("DC→DC webhook send failed, refreshing:", error.message || error);
      sink.discordWebhook = await ensureDiscordRelayWebhook(sink.discordChannel);
      if (sink.discordWebhook) {
        try {
          const sent = await sink.discordWebhook.send({
            content,
            username: senderName.slice(0, 80),
            avatarURL: senderAvatarUrl || undefined,
            allowedMentions: { parse: [] }
          });
          return { relayId: sent.id, viaWebhook: true, savedAt: Date.now() };
        } catch (retryError) {
          logger.warn("DC→DC webhook retry failed, falling back:", retryError.message || retryError);
        }
      }
    }
  }

  const sent = await sink.discordChannel.send({
    content: `**${senderName}**\n${content}`,
    allowedMentions: { parse: [] }
  });
  return { relayId: sent.id, viaWebhook: false, savedAt: Date.now() };
}

async function editDiscordRelayMessage(relay, { senderName, content, sink }) {
  try {
    if (relay.viaWebhook && sink.discordWebhook) {
      await sink.discordWebhook.editMessage(relay.relayId, { content, allowedMentions: { parse: [] } });
    } else {
      const msg = await sink.discordChannel.messages.fetch(relay.relayId);
      await msg.edit({ content: `**${senderName}**\n${content}`, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    logger.warn("DC→DC relay edit failed:", error.message || error);
  }
}

async function deleteDiscordRelayEntry(relay, sink) {
  try {
    if (relay.viaWebhook && sink.discordWebhook) {
      await sink.discordWebhook.deleteMessage(relay.relayId);
    } else {
      const msg = await sink.discordChannel.messages.fetch(relay.relayId);
      await msg.delete();
    }
  } catch (error) {
    logger.warn("DC→DC relay delete failed:", error.message || error);
  }
}

// ─── Channel setup ────────────────────────────────────────────────────────────

async function resolveDiscordTargetChannel(channelId) {
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel) {
    throw new Error(`Discord channel ${channelId} not found`);
  }

  const validChannelTypes = new Set([
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.Announcement
  ]);

  if (!validChannelTypes.has(channel.type) || !channel.isTextBased()) {
    throw new Error(`Discord channel ${channelId} is not a text-based channel`);
  }

  return channel;
}

/**
 * Resolve a relay target by channel ID. Static bridge sinks are preferred;
 * dynamically-created Telegram-topic threads are fetched on demand.
 */
async function resolveRelaySink(group, channelId) {
  const existing = group.discordSinks.find((sink) => String(sink.channelId) === String(channelId));
  if (existing) return existing;

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return { channelId: String(channelId), discordChannel: channel, discordWebhook: null };
  } catch (error) {
    logger.warn(`Unable to resolve Discord relay target ${channelId}:`, error.message || error);
    return null;
  }
}

module.exports = {
  init,
  getDiscordSenderName,
  getDiscordSenderAvatarUrl,
  getDiscordMessageText,
  getDiscordAttachments,
  getDiscordStickers,
  resolveDiscordMentions,
  buildDiscordRelayContent,
  ensureDiscordRelayWebhook,
  sendTelegramToDiscord,
  editTelegramToDiscordMessage,
  deleteDiscordRelayMessage,
  relayDiscordToDiscord,
  editDiscordRelayMessage,
  deleteDiscordRelayEntry,
  resolveDiscordTargetChannel,
  resolveRelaySink
};
