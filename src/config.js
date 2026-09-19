require('dotenv').config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function optional(name, fallback = '') { return process.env[name]?.trim() || fallback; }

const baseUrl = optional('BASE_URL').replace(/\/$/, '');

module.exports = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: required('DISCORD_GUILD_ID'),
  accessRoleId: required('DISCORD_ACCESS_ROLE_ID'),
  adminDiscordIds: new Set(optional('ADMIN_DISCORD_IDS').split(',').map((v) => v.trim()).filter(Boolean)),
  dataDir: optional('DATA_DIR', './data'),
  prefix: optional('RUST_COMMAND_PREFIX', '!'),
  teamChatPollMs: Number(optional('TEAM_CHAT_POLL_MS', '2500')),
  teamInfoPollMs: Number(optional('TEAM_INFO_POLL_MS', '10000')),
  eventPollMs: Number(optional('EVENT_POLL_MS', '15000')),
  eventAlertsEnabled: optional('EVENT_ALERTS_ENABLED', 'true').toLowerCase() !== 'false',
  discordAlertChannelId: optional('DISCORD_ALERT_CHANNEL_ID'),
  port: Number(optional('PORT', '3000')),
  baseUrl: baseUrl || required('BASE_URL'),
  encryptionKey: optional('ENCRYPTION_KEY')
};
