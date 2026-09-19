const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

class DiscordManager {
  constructor({ config, db, rustClash = null }) {
    this.config = config;
    this.db = db;
    this.rustClash = rustClash;
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

  async notifyDevicePairingComplete(discordId, result) {
    try {
      const user = await this.client.users.fetch(String(discordId));
      const state = result.state == null ? 'nieznany' : (result.state ? 'ON' : 'OFF');
      await user.send(`✅ Smart Switch dodany!\n**${result.name}** — Entity \`${result.entityId}\` — stan: **${state}**\nKonto Rust+: \`${result.accountId}\`${result.groupId ? `\nGrupa: \`${result.groupId}\`` : ''}`);
    } catch (err) { console.warn('[Discord] device pairing DM failed:', err?.message || err); }
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


  #ownedRustAccounts(uid) {
    return (this.rustManager?.listStatus() || []).filter((a) => this.isAdmin(uid) || this.db.getRustAccount(a.id)?.ownerDiscordId === String(uid));
  }

  #ownedSmartGroups(uid) {
    return this.db.listSmartGroups().filter((g) => this.isAdmin(uid) || g.ownerDiscordId === String(uid));
  }

  #ownedSmartDevices(uid) {
    return this.db.listSmartDevices().filter((d) => this.isAdmin(uid) || d.ownerDiscordId === String(uid));
  }

  async #renderSmartPanel(group) {
    const statuses = await this.rustManager.getSmartGroupStatus(group);
    const account = this.db.getRustAccount(group.accountId);
    const on = statuses.filter((x) => x.ok && x.value).length;
    const off = statuses.filter((x) => x.ok && !x.value).length;
    const errors = statuses.filter((x) => !x.ok).length;
    const description = statuses.length
      ? statuses.map((x) => x.ok ? `${x.value ? '🟢' : '⚫'} **${x.device.name}** — ${x.value ? 'ON' : 'OFF'}` : `🔴 **${x.device.name}** — ${x.error || 'offline'}`).join('\n')
      : 'Brak urządzeń w tej grupie.';
    const embed = new EmbedBuilder()
      .setTitle(`🎛️ ${group.name}`)
      .setDescription(description.slice(0, 3900))
      .addFields(
        { name: 'Serwer / konto Rust+', value: account?.name || group.accountId, inline: false },
        { name: 'Status', value: `🟢 ON: **${on}**   ⚫ OFF: **${off}**   🔴 Błąd: **${errors}**`, inline: false }
      )
      .setFooter({ text: 'Rust Helper • Smart Device Panel' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`smart:on:${group.id}`).setLabel('Włącz').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`smart:off:${group.id}`).setLabel('Wyłącz').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`smart:refresh:${group.id}`).setLabel('Odśwież').setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row] };
  }

  async #handleSmartButton(interaction) {
    const parts = String(interaction.customId || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'smart') return false;
    const [, action, groupId] = parts;
    const group = this.db.getSmartGroup(groupId);
    if (!group) {
      await interaction.reply({ content: '❌ Ta grupa już nie istnieje.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!(await this.hasAccessRole(interaction.user.id)) && !this.isAdmin(interaction.user.id)) {
      await interaction.reply({ content: '⛔ Brak wymaganej roli Discord.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferUpdate();
    try {
      if (action === 'on' || action === 'off') {
        const value = action === 'on';
        const results = await this.rustManager.setSmartGroupValue(group, value);
        const failed = results.filter((x) => !x.ok);
        if (failed.length) console.warn(`[Smart] ${group.id} ${action}: ${failed.length}/${results.length} failed`);
      }
      const panel = await this.#renderSmartPanel(group);
      await interaction.editReply(panel);
    } catch (err) {
      console.error('[Smart] button failed:', err);
      try { await interaction.followUp({ content: `❌ ${err.message || err}`, flags: MessageFlags.Ephemeral }); } catch (_) {}
    }
    return true;
  }

  async #registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName('pair').setDescription('Rozpocznij pairing Rust+ krok po kroku.'),
      new SlashCommandBuilder().setName('pair-help').setDescription('Pokaż instrukcję pairingu Rust+ z EXE.'),
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
      new SlashCommandBuilder().setName('item').setDescription('Policz materiały potrzebne do craftu itemu z RustClash Wiki.')
        .addStringOption(o=>o.setName('item').setDescription('Item, np. rocket, c4, satchel').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o=>o.setName('amount').setDescription('Ilość do zrobienia').setRequired(true).setMinValue(1).setMaxValue(1000000)),
      new SlashCommandBuilder().setName('items-refresh').setDescription('Odśwież listę itemów z Rust Items API (admin).'),
      new SlashCommandBuilder().setName('device-scan').setDescription('Dodaj Smart Switch bez ręcznego Entity ID.')
        .addStringOption(o=>o.setName('name').setDescription('Nazwa urządzenia, np. Turrety dach').setRequired(false))
        .addStringOption(o=>o.setName('group').setDescription('Grupa urządzeń (opcjonalnie)').setRequired(false).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-scan-status').setDescription('Sprawdź stan parowania Smart Switcha.'),
      new SlashCommandBuilder().setName('device-group-create').setDescription('Utwórz grupę Smart Switchy (np. Turrety).')
        .addStringOption(o=>o.setName('name').setDescription('Nazwa grupy, np. Turrety').setRequired(true))
        .addStringOption(o=>o.setName('account').setDescription('Konto Rust+').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-add').setDescription('Dodaj sparowany Smart Switch do bota.')
        .addStringOption(o=>o.setName('name').setDescription('Nazwa, np. Turrety dach').setRequired(true))
        .addStringOption(o=>o.setName('account').setDescription('Konto Rust+').setRequired(true).setAutocomplete(true))
        .addStringOption(o=>o.setName('entity').setDescription('Entity ID Smart Switcha').setRequired(true))
        .addStringOption(o=>o.setName('group').setDescription('Grupa urządzeń (opcjonalnie)').setRequired(false).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-group-assign').setDescription('Przypisz urządzenie do grupy.')
        .addStringOption(o=>o.setName('device').setDescription('Urządzenie').setRequired(true).setAutocomplete(true))
        .addStringOption(o=>o.setName('group').setDescription('Grupa').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-remove').setDescription('Usuń Smart Switch z bota.')
        .addStringOption(o=>o.setName('device').setDescription('Urządzenie').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-group-remove').setDescription('Usuń grupę Smart Switchy.')
        .addStringOption(o=>o.setName('group').setDescription('Grupa').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('devices').setDescription('Pokaż zapisane Smart Switche i ich grupy.'),
      new SlashCommandBuilder().setName('device-groups').setDescription('Pokaż grupy Smart Switchy.'),
      new SlashCommandBuilder().setName('device-status').setDescription('Sprawdź stan Smart Switcha.')
        .addStringOption(o=>o.setName('device').setDescription('Urządzenie').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('device-panel').setDescription('Wyślij panel ON/OFF/STATUS na Discord.')
        .addStringOption(o=>o.setName('group').setDescription('Grupa do sterowania').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('teams').setDescription('Pokaż manualne teamy i ACTIVE/BACKUP.')
    ].map(c=>c.toJSON());
    const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
    await rest.put(Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId), { body: commands });
    console.log('[Discord] slash commands registered');
  }

  async #onInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      try {
        if (interaction.commandName === 'item' && this.rustClash) {
          const q = interaction.options.getFocused();
          const choices = this.rustClash.searchItems(q, 25).map(x => ({ name: x.name.slice(0,100), value: x.slug.slice(0,100) }));
          return interaction.respond(choices);
        }
        const uid = interaction.user.id;
        const focused = interaction.options.getFocused(true);
        const query = String(focused.value || '').toLowerCase();
        if (focused.name === 'account' && ['device-add','device-group-create'].includes(interaction.commandName)) {
          const choices = this.#ownedRustAccounts(uid).filter(a => `${a.name} ${a.id}`.toLowerCase().includes(query)).slice(0,25)
            .map(a => ({ name: `${a.connected?'🟢':'🔴'} ${a.name}`.slice(0,100), value: a.id.slice(0,100) }));
          return interaction.respond(choices);
        }
        if (focused.name === 'group' && ['device-add','device-group-assign','device-group-remove','device-panel','device-scan'].includes(interaction.commandName)) {
          const choices = this.#ownedSmartGroups(uid).filter(g => `${g.name} ${g.id}`.toLowerCase().includes(query)).slice(0,25)
            .map(g => ({ name: g.name.slice(0,100), value: g.id.slice(0,100) }));
          return interaction.respond(choices);
        }
        if (focused.name === 'device' && ['device-group-assign','device-remove','device-status'].includes(interaction.commandName)) {
          const choices = this.#ownedSmartDevices(uid).filter(d => `${d.name} ${d.entityId} ${d.id}`.toLowerCase().includes(query)).slice(0,25)
            .map(d => ({ name: `${d.name} (${d.entityId})`.slice(0,100), value: d.id.slice(0,100) }));
          return interaction.respond(choices);
        }
      } catch (_) { try { await interaction.respond([]); } catch (_) {} }
      return;
    }
    if (interaction.isButton()) { await this.#handleSmartButton(interaction); return; }
    if (!interaction.isChatInputCommand()) return;
    const uid = interaction.user.id;
    const ephemeral = MessageFlags.Ephemeral;
    try {
      if (interaction.commandName === 'pair') {
        if (!(await this.hasAccessRole(uid))) return interaction.reply({ content:'⛔ Brak wymaganej roli Discord.', flags:ephemeral });
        const t = this.pairingManager.createTicket(uid);
        const mins = Math.max(1, Math.ceil((t.expiresAt-Date.now())/60000));
        return interaction.reply({ content:[
          '🔐 **Rozpoczęto pairing Rust+**',
          `Kod: **${t.code}**`,
          '',
          '**Wykonaj to dokładnie w tej kolejności:**',
          '1. Uruchom `RustHelperPairing.exe`.',
          `2. Wklej w EXE kod **${t.code}** i zatwierdź.`,
          '3. Poczekaj, aż EXE pokaże, że **nasłuchuje / czeka na Pair with Server**.',
          '4. Dopiero teraz wejdź do Rust na serwer, który chcesz dodać.',
          '5. Otwórz Rust+ / Companion i kliknij **Pair with Server** albo **Resend Pairing**.',
          '6. Nie zamykaj EXE. Po wykryciu serwera helper sam wyśle dane do bota.',
          '7. Na Discordzie dostaniesz potwierdzenie i automatyczną diagnostykę Rust+.',
          '',
          `⏱️ Kod jest ważny około **${mins} min**.`,
          '🔒 Rust Helper nie prosi o hasło Steam i go nie zapisuje.'
        ].join('\n'), flags:ephemeral });
      }
      if (interaction.commandName === 'pair-help') {
        return interaction.reply({ content:[
          '🧭 **Jak połączyć Rust+ z botem**',
          '1. Użyj `/pair` na Discordzie.',
          '2. Uruchom `RustHelperPairing.exe`.',
          '3. Wpisz kod otrzymany z `/pair`.',
          '4. Poczekaj na komunikat EXE, że czeka na pairing.',
          '5. W Rust kliknij **Pair with Server / Resend Pairing**.',
          '6. Po kilku sekundach dostaniesz na Discordzie potwierdzenie.',
          '',
          'Jeśli kliknąłeś Pair w grze za wcześnie, użyj **Resend Pairing** po uruchomieniu EXE.',
          'Hasło Steam nie jest przesyłane do Rust Helper.'
        ].join('\n'), flags:ephemeral });
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
      if (interaction.commandName === 'item') {
        if (!(await this.hasAccessRole(uid))) return interaction.reply({content:'⛔ Brak wymaganej roli Discord.',flags:ephemeral});
        if (!this.rustClash) return interaction.reply({content:'❌ Moduł itemów jest wyłączony.',flags:ephemeral});
        const item = interaction.options.getString('item', true);
        const amount = interaction.options.getInteger('amount', true);
        await interaction.deferReply();
        try {
          const calc = await this.rustClash.calculate(item, amount);
          return interaction.editReply({ content: this.rustClash.formatCalculation(calc) });
        } catch (err) {
          console.error('[ItemsAPI] /item failed:', err);
          return interaction.editReply({ content: `❌ Nie udało się policzyć itemu: ${err.message || err}` });
        }
      }
      if (interaction.commandName === 'items-refresh') {
        if (!this.isAdmin(uid)) return interaction.reply({content:'⛔ Tylko administrator.',flags:ephemeral});
        if (!this.rustClash) return interaction.reply({content:'❌ Moduł itemów jest wyłączony.',flags:ephemeral});
        await interaction.deferReply({flags:ephemeral});
        try {
          const items = await this.rustClash.refreshIndex(true);
          return interaction.editReply({content:`✅ Odświeżono bazę itemów: **${items.length}** itemów.`});
        } catch (err) {
          return interaction.editReply({content:`❌ Items API refresh: ${err.message || err}`});
        }
      }

      if (interaction.commandName === 'device-scan') {
        if (!(await this.hasAccessRole(uid)) && !this.isAdmin(uid)) return interaction.reply({content:'⛔ Brak wymaganej roli Discord.',flags:ephemeral});
        const groupId=interaction.options.getString('group',false);
        if(groupId){const g=this.db.getSmartGroup(groupId);if(!g||(!this.isAdmin(uid)&&g.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Grupa nie istnieje albo brak dostępu.',flags:ephemeral});}
        const t=this.pairingManager.createDeviceTicket(uid,{name:interaction.options.getString('name',false)||'',groupId});
        const mins=Math.max(1,Math.ceil((t.expiresAt-Date.now())/60000));
        return interaction.reply({content:[
          '📡 **Parowanie Smart Switcha**',
          `Kod: **${t.code}**`,
          '',
          '1. Uruchom najnowszy `RustHelperPairing.exe`.',
          `2. Wklej kod **${t.code}**. Helper rozpozna tryb urządzenia.`,
          '3. Poczekaj na komunikat **[GOTOWY]**.',
          '4. W Rust podejdź do Smart Switcha i kliknij jego opcję **Pair / Pair with Rust+**.',
          '5. EXE przechwyci nowe powiadomienie z `entityId` i wyśle je do bota.',
          '6. Bot sam znajdzie właściwe konto Rust+ i zapisze urządzenie.',
          '',
          `⏱️ Kod ważny około **${mins} min**.`
        ].join('\n'),flags:ephemeral});
      }
      if (interaction.commandName === 'device-scan-status') {
        const s=this.pairingManager.deviceStatus(uid);
        if(s.phase==='idle') return interaction.reply({content:'Brak aktywnego parowania urządzenia. Użyj `/device-scan`.',flags:ephemeral});
        if(s.phase==='paired') return interaction.reply({content:`✅ Dodano **${s.result?.name||'Smart Switch'}** — Entity \`${s.result?.entityId}\`.`,flags:ephemeral});
        return interaction.reply({content:`⏳ Czekam na EXE i pairing Smart Switcha. Kod: **${s.code}**`,flags:ephemeral});
      }
      if (interaction.commandName === 'device-group-create') {
        if (!(await this.hasAccessRole(uid)) && !this.isAdmin(uid)) return interaction.reply({content:'⛔ Brak wymaganej roli Discord.',flags:ephemeral});
        const accountId=interaction.options.getString('account',true), account=this.db.getRustAccount(accountId);
        if(!account||(!this.isAdmin(uid)&&account.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Konto Rust+ nie istnieje albo brak dostępu.',flags:ephemeral});
        const group=this.db.createSmartGroup({name:interaction.options.getString('name',true),ownerDiscordId:uid,accountId});
        return interaction.reply({content:`✅ Utworzono grupę **${group.name}** — \`${group.id}\`.`,flags:ephemeral});
      }
      if (interaction.commandName === 'device-add') {
        if (!(await this.hasAccessRole(uid)) && !this.isAdmin(uid)) return interaction.reply({content:'⛔ Brak wymaganej roli Discord.',flags:ephemeral});
        const accountId=interaction.options.getString('account',true), account=this.db.getRustAccount(accountId);
        if(!account||(!this.isAdmin(uid)&&account.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Konto Rust+ nie istnieje albo brak dostępu.',flags:ephemeral});
        const groupId=interaction.options.getString('group',false);
        if(groupId){const g=this.db.getSmartGroup(groupId);if(!g||(!this.isAdmin(uid)&&g.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Grupa nie istnieje albo brak dostępu.',flags:ephemeral});}
        const device=this.db.addSmartDevice({name:interaction.options.getString('name',true),ownerDiscordId:uid,accountId,entityId:interaction.options.getString('entity',true),groupId});
        await interaction.deferReply({flags:ephemeral});
        try {
          const info=await this.rustManager.getSmartDeviceInfo(device.accountId,device.entityId);
          return interaction.editReply({content:`✅ Dodano **${device.name}** (Entity \`${device.entityId}\`) — stan: **${info.value?'ON':'OFF'}**${groupId?' — przypisano do grupy.':''}`});
        } catch(err) {
          return interaction.editReply({content:`⚠️ Urządzenie zapisane, ale Rust+ nie odczytał stanu: ${err.message||err}\nSprawdź Entity ID i czy Smart Switch jest sparowany z tym samym kontem Rust+.`});
        }
      }
      if (interaction.commandName === 'device-group-assign') {
        const deviceId=interaction.options.getString('device',true), groupId=interaction.options.getString('group',true);
        const d=this.db.getSmartDevice(deviceId), g=this.db.getSmartGroup(groupId);
        if(!d||!g||(!this.isAdmin(uid)&&(d.ownerDiscordId!==uid||g.ownerDiscordId!==uid))) return interaction.reply({content:'⛔ Urządzenie/grupa nie istnieje albo brak dostępu.',flags:ephemeral});
        this.db.assignSmartDeviceToGroup(deviceId,groupId);
        return interaction.reply({content:`✅ **${d.name}** przypisane do **${g.name}**.`,flags:ephemeral});
      }
      if (interaction.commandName === 'device-remove') {
        const id=interaction.options.getString('device',true), d=this.db.getSmartDevice(id);
        if(!d||(!this.isAdmin(uid)&&d.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Urządzenie nie istnieje albo brak dostępu.',flags:ephemeral});
        this.db.removeSmartDevice(id);
        return interaction.reply({content:`✅ Usunięto **${d.name}**.`,flags:ephemeral});
      }
      if (interaction.commandName === 'device-group-remove') {
        const id=interaction.options.getString('group',true), g=this.db.getSmartGroup(id);
        if(!g||(!this.isAdmin(uid)&&g.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Grupa nie istnieje albo brak dostępu.',flags:ephemeral});
        this.db.removeSmartGroup(id);
        return interaction.reply({content:`✅ Usunięto grupę **${g.name}**. Urządzenia pozostały zapisane.`,flags:ephemeral});
      }
      if (interaction.commandName === 'devices') {
        const rows=this.#ownedSmartDevices(uid);
        const groups=new Map(this.db.listSmartGroups().map(g=>[g.id,g]));
        const text=rows.length?rows.map(d=>`• **${d.name}** — Entity \`${d.entityId}\` — ${groups.get(d.groupId)?.name||'bez grupy'} — konto \`${d.accountId}\``).join('\n'):'Brak zapisanych Smart Switchy.';
        return interaction.reply({content:text.slice(0,1900),flags:ephemeral});
      }
      if (interaction.commandName === 'device-groups') {
        const groups=this.#ownedSmartGroups(uid);
        const text=groups.length?groups.map(g=>`• **${g.name}** — \`${g.id}\` — urządzeń: **${(g.deviceIds||[]).length}** — konto \`${g.accountId}\``).join('\n'):'Brak grup Smart Switchy.';
        return interaction.reply({content:text.slice(0,1900),flags:ephemeral});
      }
      if (interaction.commandName === 'device-status') {
        const id=interaction.options.getString('device',true), d=this.db.getSmartDevice(id);
        if(!d||(!this.isAdmin(uid)&&d.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Urządzenie nie istnieje albo brak dostępu.',flags:ephemeral});
        await interaction.deferReply({flags:ephemeral});
        const info=await this.rustManager.getSmartDeviceInfo(d.accountId,d.entityId);
        return interaction.editReply({content:`${info.value?'🟢':'⚫'} **${d.name}** — **${info.value?'ON':'OFF'}** — Entity \`${d.entityId}\``});
      }
      if (interaction.commandName === 'device-panel') {
        const id=interaction.options.getString('group',true), g=this.db.getSmartGroup(id);
        if(!g||(!this.isAdmin(uid)&&g.ownerDiscordId!==uid)) return interaction.reply({content:'⛔ Grupa nie istnieje albo brak dostępu.',flags:ephemeral});
        if(!(g.deviceIds||[]).length) return interaction.reply({content:'❌ Ta grupa nie ma jeszcze żadnych urządzeń.',flags:ephemeral});
        await interaction.deferReply();
        const panel=await this.#renderSmartPanel(g);
        return interaction.editReply(panel);
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
