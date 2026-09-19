const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events, MessageFlags
} = require('discord.js');

class DiscordManager {
  constructor({ config, db }) {
    this.config = config;
    this.db = db;
    this.rustManager = null;
    this.pairingManager = null;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  setRustManager(manager) { this.rustManager = manager; }
  setPairingManager(manager) { this.pairingManager = manager; }

  async start() {
    await this.#registerCommands();
    this.client.on('interactionCreate', (i) => this.#onInteraction(i));
    this.client.once(Events.ClientReady, () => console.log(`[Discord] logged in as ${this.client.user.tag}`));
    await this.client.login(this.config.discordToken);
  }

  async hasAccessRole(discordId) {
    try {
      const guild = await this.client.guilds.fetch(this.config.discordGuildId);
      const member = await guild.members.fetch(discordId);
      return member.roles.cache.has(this.config.accessRoleId);
    } catch (_) { return false; }
  }
  isAdmin(id) { return this.config.adminDiscordIds.has(String(id)); }

  async notifyPairingComplete(discordId, result) {
    try {
      const user = await this.client.users.fetch(String(discordId));
      await user.send(`✅ Rust+ połączone!\n**${result.name}** — \`${result.ip}:${result.port}\` — Steam \`${result.playerId}\`\nKonto zostało zapisane i bot próbuje się połączyć.`);
    } catch (err) { console.warn('[Discord] pairing DM failed:', err?.message || err); }
  }

  async notifyDiagnostics(discordId, diag) {
    try {
      const user = await this.client.users.fetch(String(discordId));
      const icon = (t) => t?.ok ? '✅' : '❌';
      const err = (t) => t?.ok ? '' : ` — ${t?.error || 'error'}`;
      const lines = ['🧪 **Rust+ diagnostics**', `Połączenie: ${diag.connected ? '✅' : '❌'}`];
      for (const name of ['getInfo','getTime','getMapMarkers','getTeamInfo','getTeamChat']) {
        const t = diag.tests?.[name];
        lines.push(`${icon(t)} ${name}${err(t)}`);
      }
      await user.send(lines.join('\n').slice(0, 1900));
    } catch (err) { console.warn('[Discord] diagnostics DM failed:', err?.message || err); }
  }

  async sendAlert(message) {
    if (!this.config.discordAlertChannelId) return false;
    try {
      const channel = await this.client.channels.fetch(this.config.discordAlertChannelId);
      if (!channel?.isTextBased()) return false;
      await channel.send(String(message).slice(0, 1900));
      return true;
    } catch (err) { console.error('[Discord] alert failed:', err?.message || err); return false; }
  }

  async #registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName('pair').setDescription('Wygeneruj kod dla RustHelperPairing.exe.'),
      new SlashCommandBuilder().setName('pair-status').setDescription('Sprawdź stan ostatniego pairingu Rust+.'),
      new SlashCommandBuilder().setName('link').setDescription('Kod Discord ↔ Steam do komend w grze.'),
      new SlashCommandBuilder().setName('unlink').setDescription('Usuń połączenie Discord ↔ Steam.'),
      new SlashCommandBuilder().setName('mysteam').setDescription('Pokaż SteamID połączone z Discordem.'),
      new SlashCommandBuilder().setName('rustaccounts').setDescription('Pokaż Twoje konta Rust+.'),
      new SlashCommandBuilder().setName('rustdiag').setDescription('Sprawdź które endpointy Rust+ działają.').addStringOption(o=>o.setName('account').setDescription('ID konta z /rustaccounts').setRequired(true)),
      new SlashCommandBuilder().setName('rustaccount-remove').setDescription('Usuń swoje konto Rust+.').addStringOption(o=>o.setName('id').setDescription('ID konta z /rustaccounts').setRequired(true)),
      new SlashCommandBuilder().setName('team-create').setDescription('Utwórz manualny team fallback.').addStringOption(o=>o.setName('name').setDescription('Nazwa teamu').setRequired(true)),
      new SlashCommandBuilder().setName('team-assign').setDescription('Przypisz swoje konto Rust+ do manualnego teamu.')
        .addStringOption(o=>o.setName('team').setDescription('ID teamu z /teams').setRequired(true))
        .addStringOption(o=>o.setName('account').setDescription('ID konta z /rustaccounts').setRequired(true)),
      new SlashCommandBuilder().setName('team-unassign').setDescription('Wypisz swoje konto z manualnego teamu.').addStringOption(o=>o.setName('account').setDescription('ID konta').setRequired(true)),
      new SlashCommandBuilder().setName('team-remove').setDescription('Usuń swój manualny team.').addStringOption(o=>o.setName('team').setDescription('ID teamu').setRequired(true)),
      new SlashCommandBuilder().setName('teams').setDescription('Pokaż manualne teamy i ACTIVE/BACKUP.')
    ].map(c=>c.toJSON());
    const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
    await rest.put(Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId), { body: commands });
    console.log('[Discord] slash commands registered');
  }

  async #onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const uid = interaction.user.id;
    const ephemeral = MessageFlags.Ephemeral;
    try {
      if (interaction.commandName === 'pair') {
        if (!(await this.hasAccessRole(uid))) return interaction.reply({ content:'⛔ Brak wymaganej roli Discord.', flags:ephemeral });
        const t = this.pairingManager.createTicket(uid);
        const mins = Math.max(1, Math.ceil((t.expiresAt-Date.now())/60000));
        return interaction.reply({ content:`🔐 Kod pairingu: **${t.code}**\n1. Uruchom \`RustHelperPairing.exe\`\n2. Wklej ten kod\n3. W Rust kliknij **Pair with Server / Resend**\nKod ważny ~${mins} min.\n\nHasło Steam nie trafia do bota ani na Discord.`, flags:ephemeral });
      }
      if (interaction.commandName === 'pair-status') {
        const s=this.pairingManager.status(uid);
        if(s.phase==='idle') return interaction.reply({content:'Brak aktywnego pairingu. Użyj `/pair`.',flags:ephemeral});
        if(s.phase==='paired') return interaction.reply({content:`✅ Sparowano: **${s.result?.name||'Rust server'}** — \`${s.result?.ip}:${s.result?.port}\``,flags:ephemeral});
        return interaction.reply({content:`⏳ Czekam na EXE. Kod: **${s.code}**`,flags:ephemeral});
      }
      if (interaction.commandName === 'link') {
        const code=this.db.createLinkCode(uid);
        return interaction.reply({content:`Kod: **${code}**\nW Rust team chacie: \`${this.config.prefix}link ${code}\``,flags:ephemeral});
      }
      if (interaction.commandName === 'unlink') {
        const ok=this.db.unlinkDiscord(uid); return interaction.reply({content:ok?'✅ Połączenie usunięte.':'Brak połączonego SteamID.',flags:ephemeral});
      }
      if (interaction.commandName === 'mysteam') {
        const id=this.db.getSteamIdByDiscordId(uid); return interaction.reply({content:id?`SteamID: \`${id}\``:'Brak połączonego SteamID.',flags:ephemeral});
      }
      if (interaction.commandName === 'rustaccounts') {
        const all=this.rustManager?.listStatus()||[];
        const rows=all.filter(a=>this.isAdmin(uid)||this.db.getRustAccount(a.id)?.ownerDiscordId===uid);
        const text=rows.length?rows.map(a=>`${a.connected?'🟢':'🔴'} \`${a.id}\` — ${a.name} — ${a.senderRole}${a.teamId?` — ${a.teamId}`:''}`).join('\n'):'Brak kont Rust+.';
        return interaction.reply({content:text.slice(0,1900),flags:ephemeral});
      }
      if (interaction.commandName === 'rustdiag') {
        const id=interaction.options.getString('account',true); const a=this.db.getRustAccount(id);
        if(!a||(!this.isAdmin(uid)&&a.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Nie znaleziono konta lub brak dostępu.',flags:ephemeral});
        await interaction.deferReply({flags:ephemeral});
        const d=await this.rustManager.diagnoseAccount(id);
        const icon=(t)=>t?.ok?'✅':'❌'; const err=(t)=>t?.ok?'':` — ${t?.error||'error'}`;
        const lines=[`🧪 **Rust+ diagnostics — ${a.name}**`,`Połączenie: ${d.connected?'✅':'❌'}`];
        for(const n of ['getInfo','getTime','getMapMarkers','getTeamInfo','getTeamChat']) { const t=d.tests?.[n]; lines.push(`${icon(t)} ${n}${err(t)}`); }
        return interaction.editReply({content:lines.join('\n').slice(0,1900)});
      }
      if (interaction.commandName === 'rustaccount-remove') {
        const id=interaction.options.getString('id',true); const a=this.db.getRustAccount(id);
        if(!a||(!this.isAdmin(uid)&&a.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Nie znaleziono konta lub brak dostępu.',flags:ephemeral});
        this.rustManager?.stop(id); this.db.removeRustAccount(id); this.rustManager?.refreshRouting();
        return interaction.reply({content:`✅ Usunięto \`${id}\`.`,flags:ephemeral});
      }
      if (interaction.commandName === 'team-create') {
        if (!(await this.hasAccessRole(uid))) return interaction.reply({content:'⛔ Brak wymaganej roli.',flags:ephemeral});
        const t=this.db.createManualTeam({name:interaction.options.getString('name',true),ownerDiscordId:uid}); this.rustManager?.refreshRouting();
        return interaction.reply({content:`✅ Team utworzony: **${t.name}** — ID \`${t.id}\``,flags:ephemeral});
      }
      if (interaction.commandName === 'team-assign') {
        const tid=interaction.options.getString('team',true), aid=interaction.options.getString('account',true);
        const t=this.db.getManualTeam(tid), a=this.db.getRustAccount(aid);
        if(!t||!a||(!this.isAdmin(uid)&&(t.ownerDiscordId!==uid||a.ownerDiscordId!==uid))) return interaction.reply({content:'⛔ Team/konto nie istnieje albo brak dostępu.',flags:ephemeral});
        this.db.assignAccountToManualTeam(tid,aid); this.rustManager?.refreshRouting();
        return interaction.reply({content:`✅ \`${aid}\` przypisane do **${t.name}**.`,flags:ephemeral});
      }
      if (interaction.commandName === 'team-unassign') {
        const aid=interaction.options.getString('account',true), a=this.db.getRustAccount(aid);
        if(!a||(!this.isAdmin(uid)&&a.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Brak dostępu.',flags:ephemeral});
        this.db.unassignAccountFromManualTeam(aid); this.rustManager?.refreshRouting();
        return interaction.reply({content:`✅ Wypisano \`${aid}\` z manualnego teamu.`,flags:ephemeral});
      }
      if (interaction.commandName === 'team-remove') {
        const tid=interaction.options.getString('team',true), t=this.db.getManualTeam(tid);
        if(!t||(!this.isAdmin(uid)&&t.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Brak dostępu.',flags:ephemeral});
        this.db.removeManualTeam(tid); this.rustManager?.refreshRouting();
        return interaction.reply({content:`✅ Usunięto team **${t.name}**.`,flags:ephemeral});
      }
      if (interaction.commandName === 'teams') {
        const teams=this.db.listManualTeams().filter(t=>this.isAdmin(uid)||t.ownerDiscordId===uid);
        const statuses=new Map((this.rustManager?.listStatus()||[]).map(x=>[x.id,x]));
        const out=teams.map(t=>{const accounts=(t.accountIds||[]).map(id=>{const s=statuses.get(id);return `${t.activeAccountId===id?'⭐ ACTIVE':'↪ BACKUP'} \`${id}\`${s?.connected?' 🟢':' 🔴'}`}).join('\n')||'— brak kont';return `**${t.name}** — \`${t.id}\`\n${accounts}`;}).join('\n\n')||'Brak manualnych teamów.';
        return interaction.reply({content:out.slice(0,1900),flags:ephemeral});
      }
    } catch(err) {
      console.error('[Discord] interaction error:',err);
      const payload={content:`❌ ${err.message||'Wystąpił błąd.'}`,flags:ephemeral};
      if(interaction.replied||interaction.deferred) await interaction.followUp(payload); else await interaction.reply(payload);
    }
  }
}

module.exports = { DiscordManager };
