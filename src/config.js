const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), process.env.CONFIG_FILE || ".env") });

function env(name) {
  if (process.env.NODE_ENV === "test") {
    return process.env[`TEST_${name}`] || process.env[name];
  }
  return process.env[name];
}

if (!env("DISCORD_TOKEN"))  throw new Error("Missing env var: DISCORD_TOKEN");
if (!env("TELEGRAM_TOKEN")) throw new Error("Missing env var: TELEGRAM_TOKEN");

const bridgeConfigs = [];
for (let i = 1; ; i++) {
  const tgId = env(`BRIDGE_${i}_TELEGRAM_CHAT_ID`);
  const dcId = env(`BRIDGE_${i}_DISCORD_CHANNEL_ID`);
  if (!tgId || !dcId) break;
  if (!/^-?\d+$/.test(tgId.trim())) {
    throw new Error(`BRIDGE_${i}_TELEGRAM_CHAT_ID must be an integer (got: "${tgId}")`);
  }
  bridgeConfigs.push({
    group:          env(`BRIDGE_${i}_GROUP`) || "default",
    telegramChatId: tgId.trim(),
    discordChannelId: dcId.trim()
  });
}

if (bridgeConfigs.length === 0) {
  throw new Error("No bridges configured. Add BRIDGE_1_TELEGRAM_CHAT_ID and BRIDGE_1_DISCORD_CHANNEL_ID to your .env");
}

module.exports = {
  discordToken:  env("DISCORD_TOKEN"),
  telegramToken: env("TELEGRAM_TOKEN"),
  bridgeConfigs
};
