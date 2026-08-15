const config = require("./config");

/**
 * A Group is a set of Telegram chats and Discord channels that relay
 * messages to each other. Messages from any TG chat go to all DC channels
 * in the same group, and vice versa.
 *
 * discordSinks: [{ channelId, discordChannel, discordWebhook }]
 *   – populated at startup by index.js
 */
function createGroup(id, entries) {
  // Deduplicate IDs in case the same chat/channel appears multiple times
  const telegramChatIds = [...new Set(entries.map((e) => e.telegramChatId))];
  const discordChannelIds = [...new Set(entries.map((e) => e.discordChannelId))];

  return {
    id,
    telegramChatIds,
    discordChannelIds,
    discordSinks: [], // [{ channelId, discordChannel, discordWebhook }]
    // Map<telegramChatId:topicId, [{ channelId: threadId, parentChannelId, name, savedAt }]>
    telegramTopics: new Map(),
    // Map<telegramKey, [{ channelId, id, viaWebhook, savedAt }]>
    telegramToDiscordMessages: new Map(),
    // Map<discordMsgId, [{ chatId, ids: number[], savedAt }]>
    discordToTelegramMessages: new Map(),
    // Map<discordSrcMsgId, [{ channelId, relayId, viaWebhook, savedAt }]>
    discordToDiscordMessages: new Map()
  };
}

// Group bridge configs by their group name
const groupMap = new Map();
for (const bc of config.bridgeConfigs) {
  if (!groupMap.has(bc.group)) groupMap.set(bc.group, []);
  groupMap.get(bc.group).push(bc);
}

const groups = Array.from(groupMap.entries()).map(([id, entries]) => createGroup(id, entries));

function getGroupByTelegramChatId(chatId) {
  return groups.find((g) => g.telegramChatIds.includes(String(chatId))) || null;
}

function getGroupByDiscordChannelId(channelId) {
  return groups.find((g) => g.discordChannelIds.includes(String(channelId))) || null;
}

module.exports = { groups, getGroupByTelegramChatId, getGroupByDiscordChannelId };
