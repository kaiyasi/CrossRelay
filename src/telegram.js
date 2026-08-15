const logger = require("./logger");
const state = require("./state");

let telegramBot = null;
let telegramBotUserId = null;
const telegramAvatarCache = new Map();
const telegramChatAvatarCache = new Map();
const AVATAR_CACHE_MAX = 500;
const MEDIA_UPLOAD_MAX_BYTES = Math.max(
  1,
  Number.parseInt(process.env.BRIDGE_MEDIA_UPLOAD_MAX_MB || "8", 10) || 8
) * 1024 * 1024;

function avatarCacheSet(cache, key, value) {
  if (cache.size >= AVATAR_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

function init(bot, botUserId) {
  telegramBot = bot;
  telegramBotUserId = botUserId;
}

/**
 * Retry an async Telegram API call up to maxAttempts times when rate-limited (429).
 * Respects the retry_after field returned by Telegram.
 */
async function retryWithBackoff(fn, maxAttempts = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error?.response?.error_code === 429 || error?.status === 429;
      const errCode = error?.code || error?.errno || "";
      const errType = error?.type || "";
      const errMsg = String(error?.message || "");
      const isTransientNetwork =
        errType === "system" ||
        ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(errCode) ||
        /network timeout|socket hang up|getaddrinfo|fetch failed|request to .* failed/i.test(errMsg);
      attempt++;
      if ((!isRateLimit && !isTransientNetwork) || attempt >= maxAttempts) throw error;
      const waitSeconds = (error?.response?.parameters?.retry_after) || (attempt * 2);
      const waitMs = waitSeconds * 1000;
      const reason = isRateLimit ? "rate limit" : "network";
      logger.warn(`Telegram ${reason} retry in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function relayTelegramToSiblingChat(targetChatId, sourceChatId, sourceMessageId) {
  try {
    const forwarded = await retryWithBackoff(() =>
      telegramBot.telegram.forwardMessage(targetChatId, sourceChatId, sourceMessageId)
    );
    return forwarded?.message_id || null;
  } catch (forwardError) {
    const detail = forwardError?.response?.description || forwardError?.message || String(forwardError);
    logger.warn(`TG→TG forward to ${targetChatId} failed, trying copyMessage:`, detail);

    const copied = await retryWithBackoff(() =>
      telegramBot.telegram.copyMessage(targetChatId, sourceChatId, sourceMessageId)
    );
    return copied?.message_id || null;
  }
}

// ─── Sender name helpers ──────────────────────────────────────────────────────

function getTelegramSenderName(from) {
  if (!from) return "Unknown Telegram User";
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || "Telegram User";
}

function getTelegramPostSenderName(message) {
  if (message.sender_chat?.title) return message.sender_chat.title;
  return getTelegramSenderName(message.from);
}

function formatTelegramDiscordSenderName(chatTitle, senderName) {
  const safeChatTitle = chatTitle || "Telegram";
  const safeSenderName = senderName || safeChatTitle;
  if (safeChatTitle === safeSenderName) return safeChatTitle;
  return `${safeChatTitle} | ${safeSenderName}`;
}

function formatTelegramSpecialMessage(message) {
  if (message.poll) {
    const poll = message.poll;
    const lines = [`📊 ${poll.question || "Telegram Poll"}`];
    for (const [index, option] of (poll.options || []).entries()) {
      const votes = option.voter_count === undefined ? "" : ` (${option.voter_count})`;
      const marker = poll.is_closed && poll.correct_option_id === index ? " ✅" : "";
      lines.push(`${index + 1}. ${option.text || "Option"}${votes}${marker}`);
    }
    if (poll.is_closed) lines.push("Status: closed");
    return lines.join("\n");
  }

  if (message.location) {
    const { latitude, longitude } = message.location;
    return `📍 Location: https://maps.google.com/?q=${latitude},${longitude}`;
  }

  if (message.venue) {
    const venue = message.venue;
    const lines = [`📍 ${venue.title || "Venue"}`];
    if (venue.address) lines.push(venue.address);
    if (venue.location) {
      lines.push(`https://maps.google.com/?q=${venue.location.latitude},${venue.location.longitude}`);
    }
    return lines.join("\n");
  }

  if (message.contact) {
    const contact = message.contact;
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Contact";
    return `👤 ${name}${contact.phone_number ? `\n${contact.phone_number}` : ""}`;
  }

  if (message.dice) {
    return `🎲 ${message.dice.emoji || "🎲"} ${message.dice.value ?? ""}`.trim();
  }

  if (Array.isArray(message.new_chat_members) && message.new_chat_members.length > 0) {
    const names = message.new_chat_members.map((user) => getTelegramSenderName(user)).join(", ");
    return `👋 ${names} joined the chat`;
  }

  if (message.left_chat_member) {
    return `👋 ${getTelegramSenderName(message.left_chat_member)} left the chat`;
  }

  return "";
}

function getTelegramMessageKey(message) {
  return `${message.chat?.id}:${message.message_id}`;
}

// ─── HTML / Markdown helpers ──────────────────────────────────────────────────

function escapeTelegramHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

/**
 * Renders Telegram message text with formatting entities into Discord markdown.
 */
function renderTelegramTextWithEntities(text, entities) {
  if (!text) return "";
  if (!Array.isArray(entities) || entities.length === 0) return text;

  const sorted = [...entities]
    .filter((e) => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length)
    .sort((a, b) => a.offset !== b.offset ? a.offset - b.offset : b.length - a.length);

  const spans = [];
  for (const entity of sorted) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    let open = "";
    let close = "";

    switch (entity.type) {
      case "bold":          open = "**";  close = "**"; break;
      case "italic":        open = "*";   close = "*";  break;
      case "underline":     open = "__";  close = "__"; break;
      case "strikethrough": open = "~~";  close = "~~"; break;
      case "spoiler":       open = "||";  close = "||"; break;
      case "code":          open = "`";   close = "`";  break;
      case "pre":
        open = entity.language ? `\`\`\`${entity.language}\n` : "```\n";
        close = "\n```";
        break;
      case "text_link":
        open = "[";
        close = `](${entity.url || ""})`;
        break;
      default: break;
    }

    if (open || close) spans.push({ open, close, start, end });
  }

  if (spans.length === 0) return text;

  const boundaries = new Set([0, text.length]);
  for (const { start, end } of spans) { boundaries.add(start); boundaries.add(end); }
  const positions = Array.from(boundaries).sort((a, b) => a - b);

  const opens = new Map();
  const closes = new Map();
  for (const { open, close, start, end } of spans) {
    if (!opens.has(start)) opens.set(start, []);
    if (!closes.has(end)) closes.set(end, []);
    opens.get(start).push(open);
    closes.get(end).unshift(close);
  }

  let output = "";
  for (let i = 0; i < positions.length - 1; i++) {
    const pos = positions[i];
    if (closes.has(pos)) output += closes.get(pos).join("");
    if (opens.has(pos)) output += opens.get(pos).join("");
    output += text.slice(pos, positions[i + 1]);
  }
  const lastPos = positions[positions.length - 1];
  if (closes.has(lastPos)) output += closes.get(lastPos).join("");

  return output;
}

function convertDiscordMarkdownToTelegramHtml(markdownText) {
  if (!markdownText) return "";

  const codeBlocks = [];
  const inlineCodes = [];

  let text = markdownText.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escapedCode = escapeTelegramHtml(code || "");
    const block = lang
      ? `<pre><code class="language-${escapeTelegramHtml(lang)}">${escapedCode}</code></pre>`
      : `<pre>${escapedCode}</pre>`;
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(block);
    return token;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@INLINE_CODE_${inlineCodes.length}@@`;
    inlineCodes.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return token;
  });

  text = escapeTelegramHtml(text);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, title, url) => `<a href="${url}">${title}</a>`);
  text = text.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
  text = text.replace(/__(.+?)__/gs, "<u>$1</u>");
  text = text.replace(/~~(.+?)~~/gs, "<s>$1</s>");
  text = text.replace(/\|\|(.+?)\|\|/gs, "<tg-spoiler>$1</tg-spoiler>");
  text = text.replace(/\*(.+?)\*/gs, "<i>$1</i>");

  codeBlocks.forEach((block, index) => { text = text.replace(`@@CODE_BLOCK_${index}@@`, block); });
  inlineCodes.forEach((code, index) => { text = text.replace(`@@INLINE_CODE_${index}@@`, code); });

  return text;
}

function chunkTelegramMessage(text, max = 3900) {
  if (text.length <= max) return [text];

  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max) {
      if (current) { chunks.push(current); current = line; }
      else { for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max)); current = ""; }
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ─── Avatar helpers ───────────────────────────────────────────────────────────

async function getTelegramUserAvatarUrl(userId) {
  if (!userId) return null;
  const cached = telegramAvatarCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < 30 * 60 * 1000) return cached.url;

  try {
    const profilePhotos = await telegramBot.telegram.getUserProfilePhotos(userId, 0, 1);
    const firstPhotoSet = profilePhotos?.photos?.[0];
    if (!firstPhotoSet || firstPhotoSet.length === 0) {
      avatarCacheSet(telegramAvatarCache, userId, { url: null, fetchedAt: now });
      return null;
    }
    const largest = firstPhotoSet[firstPhotoSet.length - 1];
    const link = await telegramBot.telegram.getFileLink(largest.file_id);
    const url = link.toString();
    avatarCacheSet(telegramAvatarCache, userId, { url, fetchedAt: now });
    return url;
  } catch (_error) {
    avatarCacheSet(telegramAvatarCache, userId, { url: null, fetchedAt: now });
    return null;
  }
}

async function getTelegramChatAvatarUrl(chatId) {
  if (!chatId) return null;
  const cached = telegramChatAvatarCache.get(chatId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < 30 * 60 * 1000) return cached.url;

  try {
    const chat = await telegramBot.telegram.getChat(chatId);
    const fileId = chat?.photo?.big_file_id || chat?.photo?.small_file_id;
    if (!fileId) {
      avatarCacheSet(telegramChatAvatarCache, chatId, { url: null, fetchedAt: now });
      return null;
    }
    const link = await telegramBot.telegram.getFileLink(fileId);
    const url = link.toString();
    avatarCacheSet(telegramChatAvatarCache, chatId, { url, fetchedAt: now });
    return url;
  } catch (_error) {
    avatarCacheSet(telegramChatAvatarCache, chatId, { url: null, fetchedAt: now });
    return null;
  }
}

async function getTelegramPostAvatarUrl(message) {
  const [userResult, chatResult] = await Promise.allSettled([
    getTelegramUserAvatarUrl(message.from?.id),
    getTelegramChatAvatarUrl(message.sender_chat?.id || message.chat?.id)
  ]);
  const userUrl = userResult.status === "fulfilled" ? userResult.value : null;
  if (userUrl) return userUrl;
  const chatUrl = chatResult.status === "fulfilled" ? chatResult.value : null;
  return chatUrl || null;
}

// ─── Media extraction ─────────────────────────────────────────────────────────

async function extractTelegramMediaUrls(message) {
  const fileIds = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    fileIds.push(message.photo[message.photo.length - 1].file_id);
  }
  if (message.document?.file_id)  fileIds.push(message.document.file_id);
  if (message.video?.file_id)     fileIds.push(message.video.file_id);
  if (message.audio?.file_id)     fileIds.push(message.audio.file_id);
  if (message.voice?.file_id)     fileIds.push(message.voice.file_id);
  if (message.animation?.file_id) fileIds.push(message.animation.file_id);

  if (message.sticker?.file_id) {
    if (message.sticker.is_animated) {
      // Animated Lottie (.tgs) — Discord can't display it; use static thumbnail instead
      const thumbId = message.sticker.thumbnail?.file_id || message.sticker.thumb?.file_id;
      if (thumbId) fileIds.push(thumbId);
      // If no thumbnail, stickerEmoji fallback will show in Discord
    } else {
      // Static .webp or video sticker (.webm) — Discord embeds these fine
      fileIds.push(message.sticker.file_id);
    }
  }

  if (fileIds.length === 0) return [];
  const uniqueFileIds = Array.from(new Set(fileIds));

  const links = await Promise.all(
    uniqueFileIds.map(async (fileId) => {
      const url = await telegramBot.telegram.getFileLink(fileId);
      return url.toString();
    })
  );

  return Array.from(new Set(links));
}

function inferMediaFilename(url, index, contentType = "") {
  try {
    const pathPart = new URL(url).pathname.split("/").pop() || "";
    if (pathPart && pathPart.includes(".")) return pathPart.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch (_) {
    // Use a deterministic fallback name below.
  }

  const extension = contentType.split("/")[1]?.split(";")[0]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  return `telegram-media-${index + 1}.${extension}`;
}

/**
 * Download Telegram media for durable Discord uploads. Files that are too
 * large or unavailable are skipped so the caller can retain the URL fallback.
 */
async function downloadTelegramMediaFiles(mediaUrls) {
  const files = [];

  for (let index = 0; index < mediaUrls.length; index++) {
    const url = mediaUrls[index];
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
      if (contentLength > MEDIA_UPLOAD_MAX_BYTES) {
        logger.warn(`Telegram media ${index + 1} exceeds upload limit; keeping URL fallback`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MEDIA_UPLOAD_MAX_BYTES) {
        logger.warn(`Telegram media ${index + 1} exceeds upload limit; keeping URL fallback`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      files.push({
        url,
        buffer,
        name: inferMediaFilename(url, index, contentType),
        contentType
      });
    } catch (error) {
      logger.warn(`Unable to download Telegram media ${index + 1}; keeping URL fallback:`, error.message || error);
    }
  }

  return files;
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

function buildTelegramMediaExtra(captionHtml, telegramThreadId = null) {
  const extra = {};
  if (captionHtml) {
    extra.caption = captionHtml.slice(0, 1024);
    extra.parse_mode = "HTML";
  }
  if (telegramThreadId !== null && telegramThreadId !== undefined) {
    extra.message_thread_id = telegramThreadId;
  }
  return extra;
}

async function downloadTelegramInputFile(url, filename) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  return { source: Buffer.from(arrayBuffer), filename };
}

async function sendTelegramMediaWithUploadFallback(sendMedia, url, filename, extra, { preferUpload = false } = {}) {
  return retryWithBackoff(async () => {
    if (preferUpload) {
      try {
        const inputFile = await downloadTelegramInputFile(url, filename);
        return await sendMedia(inputFile, extra);
      } catch (_uploadError) {
        return await sendMedia(url, extra);
      }
    }

    try {
      return await sendMedia(url, extra);
    } catch (_urlError) {
      const inputFile = await downloadTelegramInputFile(url, filename);
      return await sendMedia(inputFile, extra);
    }
  });
}

function getUrlPath(url) {
  try { return new URL(url).pathname.toLowerCase(); }
  catch (_error) { return String(url || "").toLowerCase(); }
}

async function sendDiscordAttachmentToTelegram(attachment, captionHtml = "", replyExtra = {}, telegramChatId, telegramThreadId = null) {
  const urlPath = getUrlPath(attachment.url);
  const contentType = attachment.contentType.toLowerCase();
  const extra = { ...buildTelegramMediaExtra(captionHtml, telegramThreadId), ...replyExtra };
  const preferUpload = true;

  try {
    let sent;
    if (contentType.startsWith("image/gif") || urlPath.endsWith(".gif")) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendAnimation(telegramChatId, media, options),
        attachment.url, attachment.name, extra, { preferUpload }
      );
      return sent.message_id;
    }
    if (contentType.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(urlPath)) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendPhoto(telegramChatId, media, options),
        attachment.url, attachment.name, extra, { preferUpload }
      );
      return sent.message_id;
    }
    if (contentType.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(urlPath)) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendVideo(telegramChatId, media, options),
        attachment.url, attachment.name, extra, { preferUpload }
      );
      return sent.message_id;
    }
    if (contentType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac)$/i.test(urlPath)) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendAudio(telegramChatId, media, options),
        attachment.url, attachment.name, extra, { preferUpload }
      );
      return sent.message_id;
    }
    sent = await sendTelegramMediaWithUploadFallback(
      (media, options) => telegramBot.telegram.sendDocument(telegramChatId, media, options),
      attachment.url, attachment.name, extra, { preferUpload }
    );
    return sent.message_id;
  } catch (error) {
    logger.warn("Discord attachment direct send failed, falling back to link:", error.message || error);
    const fallbackOptions = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(telegramThreadId !== null && telegramThreadId !== undefined
        ? { message_thread_id: telegramThreadId }
        : {}),
      ...(replyExtra.reply_to_message_id ? { reply_to_message_id: replyExtra.reply_to_message_id } : {})
    };
    const sent = await retryWithBackoff(() =>
      telegramBot.telegram.sendMessage(
        telegramChatId,
        `<a href="${escapeTelegramHtml(attachment.url)}">${escapeTelegramHtml(attachment.name)}</a>`,
        fallbackOptions
      )
    );
    return sent.message_id;
  }
}

async function sendDiscordStickerToTelegram(sticker, captionHtml = "", replyExtra = {}, telegramChatId, telegramThreadId = null) {
  const urlPath = getUrlPath(sticker.url);
  const extra = { ...buildTelegramMediaExtra(captionHtml, telegramThreadId), ...replyExtra };
  const preferUpload = true;

  try {
    let sent;
    if (urlPath.endsWith(".gif")) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendAnimation(telegramChatId, media, options),
        sticker.url, `${sticker.name}.gif`, extra, { preferUpload }
      );
      return sent.message_id;
    }
    if (/\.(png|jpe?g|webp)$/i.test(urlPath)) {
      sent = await sendTelegramMediaWithUploadFallback(
        (media, options) => telegramBot.telegram.sendPhoto(telegramChatId, media, options),
        sticker.url, `${sticker.name}.png`, extra, { preferUpload }
      );
      return sent.message_id;
    }
    sent = await sendTelegramMediaWithUploadFallback(
      (media, options) => telegramBot.telegram.sendDocument(telegramChatId, media, options),
      sticker.url, sticker.name, extra, { preferUpload }
    );
    return sent.message_id;
  } catch (error) {
    logger.warn("Discord sticker direct send failed, falling back to link:", error.message || error);
    const fallbackOptions = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(telegramThreadId !== null && telegramThreadId !== undefined
        ? { message_thread_id: telegramThreadId }
        : {}),
      ...(replyExtra.reply_to_message_id ? { reply_to_message_id: replyExtra.reply_to_message_id } : {})
    };
    const sent = await retryWithBackoff(() =>
      telegramBot.telegram.sendMessage(
        telegramChatId,
        `<a href="${escapeTelegramHtml(sticker.url)}">${escapeTelegramHtml(sticker.name)}</a>`,
        fallbackOptions
      )
    );
    return sent.message_id;
  }
}

function buildDiscordToTelegramTextHtml(senderName, markdownText) {
  const bodyHtml = convertDiscordMarkdownToTelegramHtml(markdownText || "");
  const senderHeaderHtml = `<b>${escapeTelegramHtml(senderName)}</b>`;
  let outgoingHtml = senderHeaderHtml;
  if (bodyHtml.trim()) outgoingHtml += `\n${bodyHtml.trim()}`;
  return { bodyHtml, senderHeaderHtml, outgoingHtml: outgoingHtml.trim() };
}

async function sendDiscordToTelegram({ senderName, markdownText, attachments, stickers, telegramChatId, telegramThreadId = null, replyToTelegramMessageId = null }) {
  const { bodyHtml, senderHeaderHtml, outgoingHtml: textHtml } = buildDiscordToTelegramTextHtml(senderName, markdownText);
  const hasMedia = attachments.length > 0 || stickers.length > 0;
  let outgoingHtml = textHtml;
  const sentMessageIds = [];

  if (!bodyHtml.trim() && hasMedia) outgoingHtml = "";

  let pendingMediaCaption = !bodyHtml.trim() && hasMedia ? senderHeaderHtml : "";
  const threadExtra = telegramThreadId !== null && telegramThreadId !== undefined
    ? { message_thread_id: telegramThreadId }
    : {};
  let replyExtra = {
    ...threadExtra,
    ...(replyToTelegramMessageId ? { reply_to_message_id: replyToTelegramMessageId } : {})
  };

  if (outgoingHtml.length > 3500) {
    const plainFallback = [`[Discord] ${senderName}`, markdownText || ""].filter(Boolean).join("\n");
    for (const part of chunkTelegramMessage(plainFallback)) {
      const sent = await retryWithBackoff(() =>
        telegramBot.telegram.sendMessage(telegramChatId, part, { disable_web_page_preview: true, ...replyExtra })
      );
      sentMessageIds.push(sent.message_id);
      replyExtra = { ...threadExtra };
    }
  } else if (outgoingHtml) {
    const sent = await retryWithBackoff(() =>
      telegramBot.telegram.sendMessage(telegramChatId, outgoingHtml, { parse_mode: "HTML", disable_web_page_preview: true, ...replyExtra })
    );
    sentMessageIds.push(sent.message_id);
    replyExtra = { ...threadExtra };
  }

  for (const attachment of attachments) {
    const messageId = await sendDiscordAttachmentToTelegram(attachment, pendingMediaCaption, replyExtra, telegramChatId, telegramThreadId);
    pendingMediaCaption = "";
    replyExtra = { ...threadExtra };
    if (messageId) sentMessageIds.push(messageId);
  }

  for (const sticker of stickers) {
    const messageId = await sendDiscordStickerToTelegram(sticker, pendingMediaCaption, replyExtra, telegramChatId, telegramThreadId);
    pendingMediaCaption = "";
    replyExtra = { ...threadExtra };
    if (messageId) sentMessageIds.push(messageId);
  }

  return sentMessageIds;
}

async function editDiscordTextOnTelegram(message, getDiscordSenderName, previousTelegramIds, telegramChatId) {
  const sender = getDiscordSenderName(message);
  const text = message.content || "";
  const attachments = Array.from(message.attachments.values());
  const stickers = message.stickers ? Array.from(message.stickers.values()) : [];

  if (attachments.length > 0 || stickers.length > 0 || previousTelegramIds.length !== 1) return false;

  const { outgoingHtml } = buildDiscordToTelegramTextHtml(sender, text);
  if (!outgoingHtml || outgoingHtml.length > 3500) return false;

  try {
    await retryWithBackoff(() =>
      telegramBot.telegram.editMessageText(
        telegramChatId, previousTelegramIds[0], undefined,
        outgoingHtml, { parse_mode: "HTML", disable_web_page_preview: true }
      )
    );
    return true;
  } catch (error) {
    logger.warn("Telegram relay edit failed, falling back to resend:", error.message || error);
    return false;
  }
}

async function deleteTelegramMessages(messageIds, telegramChatId) {
  if (!messageIds || messageIds.length === 0) return;

  const results = await Promise.allSettled(
    messageIds.map((id) => retryWithBackoff(() => telegramBot.telegram.deleteMessage(telegramChatId, id)))
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Unable to delete Telegram relay message:", result.reason?.message || result.reason);
    }
  }
}

// ─── Media group (album) buffering ───────────────────────────────────────────

const MEDIA_GROUP_DEBOUNCE_MS = 800;
const mediaGroupBuffers = new Map(); // groupId -> { timer, messages[] }

// Keys of messages our bot forwarded to sibling TG chats, used to suppress relay echoes.
// Format: "chatId:messageId"
const _pendingForwardEchoes = new Set();

function flushMediaGroup(groupId, group, sendTelegramToDiscordFn, saveBridgeStateFn, resolveSinksFn = null) {
  const buf = mediaGroupBuffers.get(groupId);
  mediaGroupBuffers.delete(groupId);
  if (!buf || buf.messages.length === 0) return;

  const allMediaUrls = buf.messages.flatMap((m) => m.mediaUrls);
  const allMediaFiles = buf.messages.flatMap((m) => m.mediaFiles || []);
  const firstWithText = buf.messages.find((m) => m.text);
  const text = firstWithText ? firstWithText.text : "";
  const sender = buf.messages[0].sender;
  const telegramKey = getTelegramMessageKey(buf.messages[0].message);

  getTelegramPostAvatarUrl(buf.messages[0].message)
    .then(async (senderAvatarUrl) => {
      const activeSinks = resolveSinksFn
        ? await resolveSinksFn(group, buf.messages[0].message)
        : group.discordSinks.filter((s) => s.discordChannel?.isTextBased());
      const allRelays = [];
      for (const sink of activeSinks) {
        const relay = await sendTelegramToDiscordFn({
          senderName: sender,
          senderAvatarUrl,
          textContent: text,
          mediaUrls: allMediaUrls,
          mediaFiles: allMediaFiles,
          stickerEmoji: "",
          replyToDiscordMessageId: null,
          bridge: sink
        });
        if (relay) allRelays.push({ channelId: sink.channelId, ...relay });
      }
      if (allRelays.length > 0) {
        group.telegramToDiscordMessages.set(telegramKey, allRelays);
        saveBridgeStateFn();
      }
    })
    .catch((error) => {
      logger.warn("Media group flush failed:", error.message || error);
    });
}

async function handleTelegramPost(
  ctx,
  group,
  sendTelegramToDiscordFn,
  editTelegramToDiscordMessageFn,
  saveBridgeStateFn,
  {
    isEdit = false,
    resolveSinks: resolveSinksFn = null,
    resolveRelaySink: resolveRelaySinkFn = null
  } = {}
) {
  const message = ctx.message || ctx.channelPost || ctx.update?.edited_message || ctx.update?.edited_channel_post;
  if (!message) return;

  if (message.from?.id && message.from.id === telegramBotUserId) return;

  // Skip relay echoes: messages our bot forwarded to sibling TG chats
  const _msgKey = `${message.chat.id}:${message.message_id}`;
  if (_pendingForwardEchoes.has(_msgKey)) {
    _pendingForwardEchoes.delete(_msgKey);
    return;
  }

  // ── Forward to sibling TG chats in same group ─────────────────────────────
  if (!isEdit && group.telegramChatIds.length > 1) {
    const sourceChatId = String(message.chat.id);
    await Promise.allSettled(
      group.telegramChatIds
        .filter((id) => id !== sourceChatId)
        .map(async (targetChatId) => {
          try {
            const relayedMsgId = await relayTelegramToSiblingChat(targetChatId, message.chat.id, message.message_id);
            if (relayedMsgId) _pendingForwardEchoes.add(`${targetChatId}:${relayedMsgId}`);
          } catch (err) {
            logger.warn(`[${group.id}] TG→TG forward to ${targetChatId} failed:`, err.message || err);
          }
        })
    );
  }

  const activeSinks = resolveSinksFn
    ? await resolveSinksFn(group, message)
    : group.discordSinks.filter((s) => s.discordChannel?.isTextBased());
  if (activeSinks.length === 0) return;

  const sender = formatTelegramDiscordSenderName(ctx.chat?.title, getTelegramPostSenderName(message));
  const rawText = message.text || message.caption || formatTelegramSpecialMessage(message);
  const entities = message.text ? message.entities : message.caption ? message.caption_entities : undefined;
  const text = renderTelegramTextWithEntities(rawText, entities);
  const mediaUrls = await extractTelegramMediaUrls(message);
  const mediaFiles = await downloadTelegramMediaFiles(mediaUrls);
  const telegramKey = getTelegramMessageKey(message);

  if (isEdit) {
    const relays = group.telegramToDiscordMessages.get(telegramKey);
    if (relays) {
      for (const relay of relays) {
        const sink = resolveRelaySinkFn
          ? await resolveRelaySinkFn(group, relay.channelId)
          : group.discordSinks.find((s) => s.channelId === relay.channelId);
        if (!sink) continue;
        await editTelegramToDiscordMessageFn(relay, {
          senderName: sender,
          textContent: text,
          mediaUrls,
          mediaFiles,
          stickerEmoji: message.sticker?.emoji || "",
          bridge: sink
        });
      }
    }
    return;
  }

  // ── Media group (album) buffering ─────────────────────────────────────────
  if (message.media_group_id) {
    const mgId = `${message.chat.id}:${message.media_group_id}`;
    if (!mediaGroupBuffers.has(mgId)) {
      mediaGroupBuffers.set(mgId, { messages: [], timer: null });
    }
    const buf = mediaGroupBuffers.get(mgId);
    buf.messages.push({ message, sender, text, mediaUrls, mediaFiles });
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(
      () => flushMediaGroup(mgId, group, sendTelegramToDiscordFn, saveBridgeStateFn, resolveSinksFn),
      MEDIA_GROUP_DEBOUNCE_MS
    );
    return;
  }

  const senderAvatarUrl = await getTelegramPostAvatarUrl(message);

  // ── Send to each Discord sink ─────────────────────────────────────────────
  const allRelays = [];
  for (const sink of activeSinks) {
    const replyToDiscordMessageId = state.findReplyDiscordMsgId(group, message, sink.channelId);
    const relay = await sendTelegramToDiscordFn({
      senderName: sender,
      senderAvatarUrl,
      textContent: text,
      mediaUrls,
      mediaFiles,
      stickerEmoji: message.sticker?.emoji || "",
      replyToDiscordMessageId,
      bridge: sink
    });
    if (relay) allRelays.push({ channelId: sink.channelId, ...relay });
  }

  if (allRelays.length > 0) {
    group.telegramToDiscordMessages.set(telegramKey, allRelays);
    saveBridgeStateFn();
  }
}

module.exports = {
  init,
  getTelegramSenderName,
  getTelegramPostSenderName,
  formatTelegramDiscordSenderName,
  getTelegramMessageKey,
  escapeTelegramHtml,
  renderTelegramTextWithEntities,
  convertDiscordMarkdownToTelegramHtml,
  chunkTelegramMessage,
  getTelegramUserAvatarUrl,
  getTelegramChatAvatarUrl,
  getTelegramPostAvatarUrl,
  extractTelegramMediaUrls,
  downloadTelegramMediaFiles,
  sendDiscordToTelegram,
  editDiscordTextOnTelegram,
  deleteTelegramMessages,
  handleTelegramPost
};
