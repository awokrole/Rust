const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
  MessageFlags
} = require('discord.js');

class DiscordManager {
  constructor({ config, db }) {
    this.config = config;
    this.db = db;
    this.rustManager = null;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  setRustManager(manager) {
    this.rustManager = manager;
  }

  async start() {
    await this.#registerCommands();
    this.client.on('interactionCreate', (interaction) => this.#onInteraction(interaction));
    this.client.once(Events.ClientReady, () => {
      console.log(`[Discord] logged in as ${this.client.user.tag}`);
    });
    await this.client.login(this.config.discordToken);
  }

  async hasAccessRole(discordId) {
    try {
      const guild = await this.client.guilds.fetch(this.config.discordGuildId);
      const member = await guild.members.fetch(discordId);
      return member.roles.cache.has(this.config.accessRoleId);
    } catch (_) {
      return false;
    }
  }

  isAdmin(discordId) {
    return this.config.adminDiscordIds.has(discordId);
  }

  async sendAlert(message) {
    const channelId = this.config.discordAlertChannelId;
    if (!channelId) return false;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      await channel.send(String(message).slice(0, 1900));
      return true;
    } catch (err) {
      console.error('[Discord] alert failed:', err?.message || err);
      return false;
    }
  }

  async #registerCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('link')
        .setDescription('Wygeneruj kod do połączenia Discord ↔ Steam.'),
      new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Usuń swoje połączenie Discord ↔ Steam.'),
      new SlashCommandBuilder()
        .setName('mysteam')
        .setDescription('Pokaż SteamID połączone z Twoim Discordem.'),
      new SlashCommandBuilder()
        .setName('rustaccount-add')
        .setDescription('Dodaj konto/sesję Rust+ do bota.')
        .addStringOption((o) => o.setName('id').setDescription('Krótki identyfikator, np. team-a').setRequired(true))
        .addStringOption((o) => o.setName('name').setDescription('Nazwa serwera/konta').setRequired(true))
        .addStringOption((o) => o.setName('ip').setDescription('IP lub hostname Companion Server').setRequired(true))
        .addIntegerOption((o) => o.setName('port').setDescription('Rust+ app.port').setMinValue(1).setMaxValue(65535).setRequired(true))
        .addStringOption((o) => o.setName('playerid').setDescription('SteamID64 konta Rust+').setRequired(true))
        .addStringOption((o) => o.setName('playertoken').setDescription('playerToken z pairingu').setRequired(true)),
      new SlashCommandBuilder()
        .setName('rustaccount-remove')
        .setDescription('Usuń konto/sesję Rust+ z bota.')
        .addStringOption((o) => o.setName('id').setDescription('ID konta').setRequired(true)),
      new SlashCommandBuilder()
        .setName('rustaccount-list')
        .setDescription('Pokaż skonfigurowane sesje Rust+ i ich status.')
    ].map((command) => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
    await rest.put(
      Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId),
      { body: commands }
    );
    console.log('[Discord] slash commands registered');
  }

  async #onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'link') {
        const code = this.db.createLinkCode(interaction.user.id);
        await interaction.reply({
          content: `Twój kod: **${code}**\nW Rust team chacie wpisz: \`${this.config.prefix}link ${code}\`\nKod wygasa za 10 minut.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === 'unlink') {
        const removed = this.db.unlinkDiscord(interaction.user.id);
        await interaction.reply({ content: removed ? '✅ Połączenie usunięte.' : 'Nie masz połączonego SteamID.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'mysteam') {
        const steamId = this.db.getSteamIdByDiscordId(interaction.user.id);
        await interaction.reply({ content: steamId ? `Połączone SteamID: \`${steamId}\`` : 'Brak połączonego SteamID.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (!this.isAdmin(interaction.user.id)) {
        await interaction.reply({ content: '⛔ Ta komenda jest tylko dla administratorów bota.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rustaccount-add') {
        const tokenRaw = interaction.options.getString('playertoken', true).trim();
        if (!/^-?\d+$/.test(tokenRaw)) throw new Error('playerToken musi być liczbą całkowitą.');

        const account = this.db.upsertRustAccount({
          id: interaction.options.getString('id', true).trim().toLowerCase(),
          name: interaction.options.getString('name', true).trim(),
          ip: interaction.options.getString('ip', true).trim(),
          port: interaction.options.getInteger('port', true),
          playerId: interaction.options.getString('playerid', true).trim(),
          playerToken: Number(tokenRaw),
          ownerDiscordId: interaction.user.id
        });

        this.rustManager?.start(account);
        await interaction.reply({ content: `✅ Dodano Rust+ account \`${account.id}\`. Bot próbuje się połączyć.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rustaccount-remove') {
        const id = interaction.options.getString('id', true).trim().toLowerCase();
        this.rustManager?.stop(id);
        const removed = this.db.removeRustAccount(id);
        await interaction.reply({ content: removed ? `✅ Usunięto \`${id}\`.` : `Nie znaleziono \`${id}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rustaccount-list') {
        const rows = this.rustManager?.listStatus() || [];
        const content = rows.length
          ? rows.map((a) => `${a.connected ? '🟢' : '🔴'} \`${a.id}\` — ${a.name} — ${a.ip}:${a.port} — Steam ${a.playerId} — ${a.senderRole}${a.teamId ? ` (${a.teamId})` : ''}`).join('\n')
          : 'Brak skonfigurowanych kont Rust+.';
        await interaction.reply({ content: content.slice(0, 1900), flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      console.error('[Discord] interaction error:', err);
      const payload = { content: `❌ ${err.message || 'Wystąpił błąd.'}`, flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
  }
}

module.exports = { DiscordManager };
