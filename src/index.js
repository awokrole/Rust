const config = require('./config');
const { SecretBox } = require('./crypto');
const { JsonDb } = require('./db');
const { DiscordManager } = require('./discord');
const { RustManager } = require('./rust');
const { WebPanel } = require('./web');

async function main() {
  const secretBox = new SecretBox(config.encryptionKey);
  if (!secretBox.enabled) console.warn('[Security] ENCRYPTION_KEY missing: Rust+ tokens are not encrypted at rest. Set it before Railway deploy.');

  const db = new JsonDb(config.dataDir, secretBox);
  const discord = new DiscordManager({ config, db });
  const rust = new RustManager({
    db,
    discord,
    prefix: config.prefix,
    chatPollMs: config.teamChatPollMs,
    teamInfoPollMs: config.teamInfoPollMs,
    eventPollMs: config.eventPollMs,
    eventAlertsEnabled: config.eventAlertsEnabled
  });
  discord.setRustManager(rust);

  await discord.start();
  rust.startAll();
  const web = new WebPanel({ config, db, discord, rustManager: rust });
  web.start();

  const shutdown = () => {
    console.log('Shutting down...');
    web.stop();
    for (const account of db.listRustAccounts()) rust.stop(account.id);
    discord.client.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
