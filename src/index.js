const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { Telegraf } = require("telegraf");
const config = require("./config");
const logger = require("./logger");
const state = require("./state");
const { groups, getGroupByTelegramChatId, getGroupByDiscordChannelId } = require("./groups");
const tg = require("./telegram");
const dc = require("./discord");

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

const telegramBot = new Telegraf(config.telegramToken);

function isBridgeOwnedDiscordMessage(message, group) {
  if (message.author?.id && message.author.id === discordClient.user?.id) return true;
  if (!message.webhookId) return false;
  return group.discordSinks.some((sink) => sink.discordWebhook?.id === message.webhookId);
}

function getGroupForDiscordMessage(message) {
  const directGroup = getGroupByDiscordChannelId(message.channelId);
  if (directGroup) return directGroup;

  const parentChannelId = message.channel?.parentId || message.channel?.parent?.id;
  const parentGroup = parentChannelId ? getGroupByDiscordChannelId(parentChannelId) : null;
  if (parentGroup) return parentGroup;

  // Delete/update events can arrive with only a partial thread channel. The
  // persisted topic map still lets us identify the owning bridge group.
  return groups.find((group) => Array.from(group.telegramTopics.values()).some((mappings) =>
    mappings.some((mapping) => String(mapping.channelId) === String(message.channelId))
  )) || null;
}

function getTelegramTopicKey(message) {
  if (message?.message_thread_id === undefined || message?.message_thread_id === null) return null;
  if (!message?.chat?.id) return null;
  return `${message.chat.id}:${message.message_thread_id}`;
}

function getTelegramTopicName(message, fallback) {
  const explicitName = message?.forum_topic_created?.name || message?.forum_topic_edited?.name;
  const name = String(explicitName || fallback || "").replace(/\s+/g, " ").trim();
  return (name || "Telegram Topic").slice(0, 100);
}

/**
 * Route Telegram forum-topic messages into matching Discord threads. If the
 * bot cannot create/manage a thread, fall back to the configured parent
 * channel so one missing permission never takes down the bridge.
 */
async function resolveTelegramSinks(group, message) {
  const baseSinks = group.discordSinks.filter((sink) => sink.discordChannel?.isTextBased());
  const topicKey = getTelegramTopicKey(message);
  if (!topicKey) return baseSinks;

  const topicId = String(message.message_thread_id);
  const existingMappings = group.telegramTopics.get(topicKey) || [];
  const sinks = [];
  let changed = false;

  for (const baseSink of baseSinks) {
    let mapping = existingMappings.find(
      (candidate) => String(candidate.parentChannelId) === String(baseSink.channelId)
    );
    const topicName = getTelegramTopicName(message, mapping?.name || `TG Topic ${topicId}`);
    let thread = null;

    if (mapping?.channelId) {
      try {
        const candidate = await discordClient.channels.fetch(mapping.channelId);
        if (candidate?.isThread?.() && String(candidate.parentId) === String(baseSink.channelId)) {
          thread = candidate;
          if (candidate.archived && candidate.manageable) await candidate.setArchived(false);
          if (message.forum_topic_edited?.name && candidate.name !== topicName && candidate.editable) {
            await candidate.setName(topicName);
          }
        }
      } catch (error) {
        logger.warn(`[${group.id}] Unable to reuse Telegram topic thread ${mapping.channelId}:`, error.message || error);
      }
    }

    if (!thread && typeof baseSink.discordChannel.threads?.create === "function") {
      try {
        thread = await baseSink.discordChannel.threads.create({
          name: topicName,
          autoArchiveDuration: 1440,
          reason: `TG Bridge topic ${topicId}`
        });
      } catch (error) {
        logger.warn(`[${group.id}] Unable to create Discord thread for Telegram topic ${topicId}:`, error.message || error);
      }
    }

    if (!thread) {
      sinks.push(baseSink);
      continue;
    }

    const nextMapping = {
      channelId: thread.id,
      parentChannelId: baseSink.channelId,
      name: topicName,
      savedAt: Date.now()
    };
    if (!mapping || String(mapping.channelId) !== String(nextMapping.channelId) || mapping.name !== nextMapping.name) {
      const mappingIndex = mapping ? existingMappings.indexOf(mapping) : -1;
      if (mappingIndex >= 0) existingMappings[mappingIndex] = nextMapping;
      else existingMappings.push(nextMapping);
      changed = true;
    }

    sinks.push({
      ...baseSink,
      channelId: thread.id,
      discordChannel: thread,
      // A parent webhook cannot be used transparently for every thread. Use
      // normal bot messages in topic threads and keep webhook identity on the
      // ordinary channel route.
      discordWebhook: null,
      telegramTopicKey: topicKey
    });
  }

  if (changed) {
    group.telegramTopics.set(topicKey, existingMappings);
    state.saveBridgeState(group);
  }

  return sinks;
}

// ─── Telegram events ──────────────────────────────────────────────────────────

function makeTelegramHandler(opts = {}) {
  return async (ctx) => {
    const chatId = String(ctx.chat?.id);
    const group = getGroupByTelegramChatId(chatId);
    if (!group) return;

    try {
      await tg.handleTelegramPost(
        ctx, group,
        dc.sendTelegramToDiscord.bind(dc),
        dc.editTelegramToDiscordMessage.bind(dc),
        () => state.saveBridgeState(group),
        {
          ...opts,
          resolveSinks: resolveTelegramSinks,
          resolveRelaySink: dc.resolveRelaySink
        }
      );
    } catch (error) {
      logger.error(`[${group.id}] Telegram -> Discord forwarding failed:`, error);
    }
  };
}

for (const event of ["message", "channel_post"]) {
  telegramBot.on(event, makeTelegramHandler());
}
for (const event of ["edited_message", "edited_channel_post"]) {
  telegramBot.on(event, makeTelegramHandler({ isEdit: true }));
}

// ─── Discord events ───────────────────────────────────────────────────────────

discordClient.on("messageCreate", async (message) => {
  const group = getGroupForDiscordMessage(message);
  if (!group) return;
  if (isBridgeOwnedDiscordMessage(message, group)) return;

  try {
    const sender = dc.getDiscordSenderName(message);
    const attachments = dc.getDiscordAttachments(message);
    const stickers = dc.getDiscordStickers(message);
    const resolvedContent = dc.getDiscordMessageText(message);

    // ── DC → TG ───────────────────────────────────────────────────────────
    const tgEntries = [];
    for (const chatId of group.telegramChatIds) {
      let replyToTelegramMessageId = null;
      if (message.reference?.messageId) {
        replyToTelegramMessageId = state.findReplyTelegramMsgId(group, message.reference.messageId, chatId);
      }
      const telegramThreadId = state.findTelegramTopicForDiscordThread(group, message.channelId, chatId);
      const telegramMessageIds = await tg.sendDiscordToTelegram({
        senderName: sender,
        markdownText: resolvedContent,
        attachments,
        stickers,
        telegramChatId: chatId,
        telegramThreadId,
        replyToTelegramMessageId
      });
      tgEntries.push({ chatId, threadId: telegramThreadId, ids: telegramMessageIds, savedAt: Date.now() });
    }
    if (tgEntries.length > 0) group.discordToTelegramMessages.set(message.id, tgEntries);

    // ── DC → other DC sinks in same group ─────────────────────────────────
    const otherSinks = message.channel?.isThread?.() ? [] : group.discordSinks.filter(
      (s) => s.channelId !== message.channelId && s.discordChannel?.isTextBased()
    );
    if (otherSinks.length > 0) {
      const relayContent = dc.buildDiscordRelayContent(message);
      const senderAvatarUrl = dc.getDiscordSenderAvatarUrl(message);
      const dcRelays = [];
      for (const sink of otherSinks) {
        const relay = await dc.relayDiscordToDiscord({ senderName: sender, senderAvatarUrl, content: relayContent, sink });
        if (relay) dcRelays.push({ channelId: sink.channelId, ...relay });
      }
      if (dcRelays.length > 0) group.discordToDiscordMessages.set(message.id, dcRelays);
    }

    if (tgEntries.length > 0 || group.discordToDiscordMessages.has(message.id)) {
      state.saveBridgeState(group);
    }
  } catch (error) {
    logger.error(`[${group.id}] Discord -> relay forwarding failed:`, error);
  }
});

discordClient.on("messageUpdate", async (_oldMessage, newMessage) => {
  const group = getGroupForDiscordMessage(newMessage);
  if (!group) return;

  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (isBridgeOwnedDiscordMessage(message, group)) return;

    // ── Update TG relays ──────────────────────────────────────────────────
    const entries = group.discordToTelegramMessages.get(message.id);
    if (entries) {
      const updatedEntries = [];
      for (const entry of entries) {
        const edited = await tg.editDiscordTextOnTelegram(message, dc.getDiscordSenderName, entry.ids, entry.chatId);
        if (edited) { updatedEntries.push(entry); continue; }

        await tg.deleteTelegramMessages(entry.ids, entry.chatId);
        const telegramMessageIds = await tg.sendDiscordToTelegram({
          senderName: dc.getDiscordSenderName(message),
          markdownText: dc.getDiscordMessageText(message),
          attachments: dc.getDiscordAttachments(message),
          stickers: dc.getDiscordStickers(message),
          telegramChatId: entry.chatId,
          telegramThreadId: entry.threadId
        });
        updatedEntries.push({ chatId: entry.chatId, threadId: entry.threadId, ids: telegramMessageIds, savedAt: Date.now() });
      }
      group.discordToTelegramMessages.set(message.id, updatedEntries);
    }

    // ── Update DC→DC relays ───────────────────────────────────────────────
    const dcRelays = group.discordToDiscordMessages.get(message.id);
    if (dcRelays) {
      const relayContent = dc.buildDiscordRelayContent(message);
      const senderName = dc.getDiscordSenderName(message);
      for (const relay of dcRelays) {
        const sink = group.discordSinks.find((s) => s.channelId === relay.channelId);
        if (sink) await dc.editDiscordRelayMessage(relay, { senderName, content: relayContent, sink });
      }
    }

    state.saveBridgeState(group);
  } catch (error) {
    logger.error(`[${group.id}] Discord edit -> relay forwarding failed:`, error);
  }
});

discordClient.on("messageDelete", async (message) => {
  const group = getGroupForDiscordMessage(message);
  if (!group) return;

  try {
    const entries = group.discordToTelegramMessages.get(message.id);
    if (entries) {
      for (const entry of entries) {
        await tg.deleteTelegramMessages(entry.ids, entry.chatId);
      }
      group.discordToTelegramMessages.delete(message.id);
    }

    // ── Delete DC→DC relays ───────────────────────────────────────────────
    const dcRelays = group.discordToDiscordMessages.get(message.id);
    if (dcRelays) {
      for (const relay of dcRelays) {
        const sink = group.discordSinks.find((s) => s.channelId === relay.channelId);
        if (sink) await dc.deleteDiscordRelayEntry(relay, sink);
      }
      group.discordToDiscordMessages.delete(message.id);
    }

    if (entries || dcRelays) state.saveBridgeState(group);
  } catch (error) {
    logger.error(`[${group.id}] Discord delete -> relay forwarding failed:`, error);
  }
});

discordClient.on("messageDeleteBulk", async (messages) => {
  const byGroup = new Map();
  for (const [id, msg] of messages) {
    const group = getGroupForDiscordMessage(msg || {});
    if (!group) continue;
    if (!byGroup.has(group.id)) byGroup.set(group.id, { group, ids: [] });
    byGroup.get(group.id).ids.push(id);
  }

  for (const { group, ids } of byGroup.values()) {
    try {
      await Promise.allSettled(ids.map(async (discordId) => {
        const entries = group.discordToTelegramMessages.get(discordId);
        if (entries) {
          for (const entry of entries) await tg.deleteTelegramMessages(entry.ids, entry.chatId);
          group.discordToTelegramMessages.delete(discordId);
        }
        const dcRelays = group.discordToDiscordMessages.get(discordId);
        if (dcRelays) {
          for (const relay of dcRelays) {
            const sink = group.discordSinks.find((s) => s.channelId === relay.channelId);
            if (sink) await dc.deleteDiscordRelayEntry(relay, sink);
          }
          group.discordToDiscordMessages.delete(discordId);
        }
      }));
      state.saveBridgeState(group);
    } catch (error) {
      logger.error(`[${group.id}] Discord bulk delete -> relay forwarding failed:`, error);
    }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  state.loadBridgeState(groups);
  state.logTrackedChatIds(groups);

  const me = await telegramBot.telegram.getMe();
  tg.init(telegramBot, me.id);
  dc.init(discordClient);

  await discordClient.login(config.discordToken);
  await new Promise((resolve) => {
    if (discordClient.isReady()) { resolve(); return; }
    discordClient.once("clientReady", resolve);
  });

  for (const group of groups) {
    // Validate all Telegram chats
    for (const chatId of group.telegramChatIds) {
      try {
        await telegramBot.telegram.getChat(chatId);
      } catch (error) {
        const detail = error?.response?.description || error?.message || String(error);
        throw new Error(
          `[${group.id}] Unable to access Telegram chat ${chatId}. ` +
          `Ensure the bot is a member/admin. Telegram says: ${detail}`
        );
      }
    }

    // Resolve and init all Discord sinks
    for (const channelId of group.discordChannelIds) {
      const discordChannel = await dc.resolveDiscordTargetChannel(channelId);
      const discordWebhook = await dc.ensureDiscordRelayWebhook(discordChannel);
      group.discordSinks.push({ channelId, discordChannel, discordWebhook });
      logger.info(`[${group.id}] Discord channel ${channelId} (${discordChannel.name}) ready`);
    }

    logger.info(`[${group.id}] TG [${group.telegramChatIds.join(", ")}] ↔ DC [${group.discordChannelIds.join(", ")}]`);
  }

  await telegramBot.launch();

  logger.info(`Bridge running — ${groups.length} group(s) active.`);
  logger.info(`Discord bot: ${discordClient.user?.tag || "unknown"}`);
  logger.info(`Telegram bot: @${me.username}`);
}

start().catch((error) => {
  logger.error("Failed to start bridge:", error);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  try {
    logger.info(`Received ${signal}, shutting down...`);
    telegramBot.stop(signal);
    await discordClient.destroy();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
