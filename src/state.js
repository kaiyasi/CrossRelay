const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const bridgeStatePath = path.resolve(
  process.cwd(),
  process.env.BRIDGE_STATE_PATH || "bridge-state.json"
);

const MAX_ENTRIES = Math.max(
  100,
  Number.parseInt(process.env.BRIDGE_STATE_MAX_ENTRIES || "10000", 10) || 10000
);
const MAX_AGE_HOURS = Math.max(
  1,
  Number.parseInt(process.env.BRIDGE_STATE_MAX_AGE_HOURS || "168", 10) || 168
);
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

const saveDebounceTimers = new Map();
let _groups = [];

function initState(groups) {
  _groups = groups;
}

// ── Format helpers ─────────────────────────────────────────────────────────────
// telegramToDiscordMessages value: [{ channelId, id, viaWebhook, savedAt }]
// discordToTelegramMessages value: [{ chatId, ids: number[], savedAt }]
// telegramTopics value: [{ channelId: threadId, parentChannelId, name, savedAt }]

function normaliseTgToDiscord(value, fallbackChannelId) {
  if (Array.isArray(value) && value[0]?.channelId !== undefined) return value; // new
  if (value?.id !== undefined) return [{ channelId: fallbackChannelId || "unknown", id: value.id, viaWebhook: value.viaWebhook ?? false, savedAt: value.savedAt }];
  return null;
}

function normaliseDiscordToTg(value, fallbackChatId) {
  if (Array.isArray(value) && value[0]?.chatId !== undefined) return value; // new
  if (Array.isArray(value)) return [{ chatId: fallbackChatId || "unknown", ids: value, savedAt: Date.now() }]; // legacy plain array
  if (value?.ids !== undefined) return [{ chatId: fallbackChatId || "unknown", ids: value.ids, savedAt: value.savedAt }]; // old { ids, savedAt }
  return null;
}

// ── Load / save ────────────────────────────────────────────────────────────────

function loadBridgeState(groups) {
  _groups = groups;
  try {
    if (!fs.existsSync(bridgeStatePath)) return;
    const saved = JSON.parse(fs.readFileSync(bridgeStatePath, "utf8"));

    for (const group of groups) {
      // New keyed format: saved[group.id]
      // Legacy flat format (single group): saved.telegramToDiscordMessages
      let data = saved[group.id];
      if (!data && groups.length === 1 && saved.telegramToDiscordMessages) data = saved;
      if (!data) continue;

      const fallbackChannel = group.discordChannelIds[0];
      const fallbackChat    = group.telegramChatIds[0];

      for (const [key, value] of Object.entries(data.telegramToDiscordMessages || {})) {
        const norm = normaliseTgToDiscord(value, fallbackChannel);
        if (norm) group.telegramToDiscordMessages.set(key, norm);
      }
      for (const [key, value] of Object.entries(data.discordToTelegramMessages || {})) {
        const norm = normaliseDiscordToTg(value, fallbackChat);
        if (norm) group.discordToTelegramMessages.set(key, norm);
      }
      for (const [key, value] of Object.entries(data.telegramTopics || {})) {
        if (Array.isArray(value)) group.telegramTopics.set(key, value);
      }
      for (const [key, value] of Object.entries(data.discordToDiscordMessages || {})) {
        if (Array.isArray(value)) group.discordToDiscordMessages.set(key, value);
      }
    }
  } catch (error) {
    logger.warn("Unable to load bridge state:", error.message || error);
  }
}

function pruneOldEntries(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    // value is an array; use the savedAt of the first entry
    const savedAt = Array.isArray(value) ? value[0]?.savedAt : value?.savedAt;
    if (savedAt !== undefined && now - savedAt > MAX_AGE_MS) {
      map.delete(key);
    }
  }
  if (map.size > MAX_ENTRIES) {
    const sorted = Array.from(map.entries()).sort((a, b) => {
      const aAt = Array.isArray(a[1]) ? (a[1][0]?.savedAt || 0) : (a[1]?.savedAt || 0);
      const bAt = Array.isArray(b[1]) ? (b[1][0]?.savedAt || 0) : (b[1]?.savedAt || 0);
      return aAt - bAt;
    });
    for (const [key] of sorted.slice(0, map.size - MAX_ENTRIES)) map.delete(key);
  }
}

async function flushBridgeState(groups) {
  const state = {};
  for (const group of groups) {
    pruneOldEntries(group.telegramToDiscordMessages);
    pruneOldEntries(group.discordToTelegramMessages);
    pruneOldEntries(group.discordToDiscordMessages);
    state[group.id] = {
      telegramTopics: Object.fromEntries(group.telegramTopics),
      telegramToDiscordMessages: Object.fromEntries(group.telegramToDiscordMessages),
      discordToTelegramMessages: Object.fromEntries(group.discordToTelegramMessages),
      discordToDiscordMessages: Object.fromEntries(group.discordToDiscordMessages)
    };
  }

  const tmpPath = bridgeStatePath + ".tmp";
  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.promises.rename(tmpPath, bridgeStatePath);
  } catch (error) {
    logger.warn("Unable to save bridge state:", error.message || error);
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* ignore */ }
  }
}

function saveBridgeState(group) {
  const t = saveDebounceTimers.get(group.id);
  if (t) clearTimeout(t);
  saveDebounceTimers.set(group.id, setTimeout(() => {
    saveDebounceTimers.delete(group.id);
    flushBridgeState(_groups);
  }, 500));
}

// ── Reply lookups ──────────────────────────────────────────────────────────────

/**
 * TG → DC reply: find the relay Discord message ID for a given sink channel.
 * Handles Scenario B (TG replying to TG-originated) and C (TG replying to DC-originated).
 */
function findReplyDiscordMsgId(group, message, sinkChannelId) {
  if (!message.reply_to_message) return null;
  const replyMsgId = message.reply_to_message.message_id;
  const replyKey   = `${message.chat.id}:${replyMsgId}`;

  // Scenario B: replied-to message was a TG-originated relay
  const relays = group.telegramToDiscordMessages.get(replyKey);
  if (relays) {
    const relay = relays.find((r) => r.channelId === sinkChannelId);
    if (relay) return relay.id;
  }

  // Scenario C: replied-to message was a DC-originated relay (bot sent it to TG)
  for (const [discordMsgId, entries] of group.discordToTelegramMessages) {
    for (const entry of entries) {
      if (String(entry.chatId) === String(message.chat.id) && entry.ids.includes(replyMsgId)) {
        return discordMsgId;
      }
    }
  }
  return null;
}

/**
 * DC → TG reply: find the relay Telegram message ID for a given target TG chat.
 * Handles Scenario A (DC replying to DC-originated) and D (DC replying to TG-originated).
 */
function findReplyTelegramMsgId(group, discordRefMsgId, targetChatId) {
  // Scenario A: referenced DC msg was relayed from DC to TG
  const entries = group.discordToTelegramMessages.get(discordRefMsgId);
  if (entries) {
    const entry = entries.find((e) => String(e.chatId) === String(targetChatId));
    if (entry) return entry.ids[0] || null;
  }

  // Scenario D: referenced DC msg was relayed from TG (original TG msg in targetChatId)
  for (const [telegramKey, relays] of group.telegramToDiscordMessages) {
    const relay = relays.find((r) => r.id === discordRefMsgId);
    if (relay) {
      const [keyChatId, msgIdStr] = telegramKey.split(":");
      if (String(keyChatId) === String(targetChatId)) {
        return parseInt(msgIdStr, 10);
      }
    }
  }
  return null;
}

/**
 * Find the Telegram forum topic represented by a Discord thread.
 * Returns the numeric topic ID, or null when the Discord channel is not mapped.
 */
function findTelegramTopicForDiscordThread(group, discordChannelId, targetChatId) {
  const wantedChannelId = String(discordChannelId);
  const wantedChatId = String(targetChatId);

  for (const [key, mappings] of group.telegramTopics) {
    const separator = key.indexOf(":");
    if (separator < 0 || key.slice(0, separator) !== wantedChatId) continue;

    for (const mapping of mappings || []) {
      if (String(mapping.channelId) !== wantedChannelId) continue;
      const topicId = Number(key.slice(separator + 1));
      return Number.isInteger(topicId) ? topicId : null;
    }
  }

  return null;
}

// ── Logging ────────────────────────────────────────────────────────────────────

function logTrackedChatIds(groups) {
  let anyTracked = false;
  for (const group of groups) {
    const chatIds = new Set(
      Array.from(group.telegramToDiscordMessages.keys()).map((k) => k.split(":")[0])
    );
    if (chatIds.size === 0) continue;
    anyTracked = true;
    logger.info(`[${group.id}] Tracked Telegram chat ID(s):`);
    for (const id of chatIds) {
      const count = Array.from(group.telegramToDiscordMessages.keys())
        .filter((k) => k.startsWith(`${id}:`)).length;
      logger.info(`  chat ${id} — ${count} mapping(s)`);
    }
  }
  if (!anyTracked) logger.info("Bridge state: no tracked chat IDs.");
}

module.exports = {
  initState,
  loadBridgeState,
  saveBridgeState,
  findReplyDiscordMsgId,
  findReplyTelegramMsgId,
  findTelegramTopicForDiscordThread,
  logTrackedChatIds
};
