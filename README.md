# CrossRelay

CrossRelay is a two-way bridge that forwards messages between Telegram chats and Discord channels.

Licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Features

- Telegram -> Discord forwarding with sender name/avatar (via webhook when available)
- Discord -> Telegram forwarding with markdown-like formatting preserved as Telegram HTML
- Media/attachments/stickers forwarding with durable Discord uploads and URL fallback
- Telegram polls, locations, contacts, dice, and member events rendered clearly in Discord
- Telegram forum topics can automatically open matching Discord threads
- Ignore bot messages to avoid feedback loops
- Split long Discord messages to fit Telegram message limit

## Requirements

- Node.js 18+
- A Telegram bot token from BotFather
- A Discord bot with access to your target server/channel

## 1) Create bots and get credentials

### Telegram

1. Open BotFather and run `/newbot`.
2. Save the bot token.
3. Add the bot into your target group/channel.
4. For groups, disable privacy mode in BotFather (`/setprivacy`) so the bot can read all messages.
5. Get your chat ID:
   - Send a message in the target chat.
   - Open: `https://api.telegram.org/bot<TELEGRAM_TOKEN>/getUpdates`
   - Find `chat.id` in the returned JSON.

### Discord

1. Create an application at Discord Developer Portal.
2. Create a bot and copy the token.
3. Enable **Message Content Intent** in bot settings.
4. Invite bot with permissions:
   - View Channel
   - Send Messages
   - Read Message History
   - Manage Webhooks (recommended, for Telegram sender avatar/name relay)
   - Manage Threads (for Telegram Topic ↔ Discord Thread routing)
5. Enable Developer Mode in Discord, right click target channel, then copy channel ID.

## 2) Setup project

```bash
npm install
```

Copy `.env.example` to `.env` and fill values:

```env
DISCORD_TOKEN=your_discord_bot_token
TELEGRAM_TOKEN=your_telegram_bot_token
BRIDGE_1_GROUP=default
BRIDGE_1_TELEGRAM_CHAT_ID=your_telegram_chat_id
BRIDGE_1_DISCORD_CHANNEL_ID=your_discord_channel_id
```

## 3) Run

```bash
npm start
```

If you see `Bridge is running.`, the bridge is active.

## 4) Test Environment

You can run test mode in two ways:

1. Use `.env.test` (recommended for separation):
   - Copy `.env.test.example` to `.env.test`
   - Fill test tokens/IDs
   - Run:

```bash
npm run start:test
```

2. Keep test values in `.env` with `TEST_` prefix:
   - Set `TEST_DISCORD_TOKEN`, `TEST_DISCORD_CHANNEL_ID`, `TEST_TELEGRAM_TOKEN`, `TEST_TELEGRAM_CHAT_ID`
   - Run with `NODE_ENV=test`

When `NODE_ENV=test`, the loader accepts both normal keys and `TEST_` keys.

## Notes

- Bridges can be grouped so one or more Telegram chats and Discord channels share the same relay pool.
- Forum-topic routing requires the Discord bot to have permission to create and manage threads. Without that permission, topic messages safely fall back to the configured channel.
- Message mappings are retained for 7 days by default. Set `BRIDGE_STATE_MAX_AGE_HOURS` and `BRIDGE_STATE_MAX_ENTRIES` in `.env` when a longer edit/delete window is needed.
- Telegram media uploads use `BRIDGE_MEDIA_UPLOAD_MAX_MB` (8 MB by default); files above the limit remain as Telegram URLs.
- Markdown and entity conversion is best-effort because Telegram and Discord formatting models are different.
- For production use, consider:
  - message deduplication IDs
  - retry queue and rate-limit backoff
  - persistent mapping for multiple chat/channel pairs
  - logging + metrics + health checks
