const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const DELTA_ROLE_ID = '1550936976985948284';
const PREFIX = 'delta:';

function formatMoney(value) {
  const n = Number(value || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${Math.trunc(n).toLocaleString('pl-PL')}`;
}

function formatShort(value) {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : (n > 0 ? '+' : '');
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.trunc(abs)}`;
}

function parseMoney(input, { allowZero = true } = {}) {
  const raw = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return allowZero ? 0 : null;

  let multiplier = 1;
  let valueText = raw;
  if (/[kmb]$/.test(valueText)) {
    const suffix = valueText.slice(-1);
    valueText = valueText.slice(0, -1);
    multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1_000_000_000;
  }

  // Accept: 1500000, 1.5m, 1,5m, 1 500 000.
  if (multiplier === 1) {
    valueText = valueText.replace(/[.,]/g, '');
  } else {
    valueText = valueText.replace(',', '.');
  }

  const numeric = Number(valueText);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const result = Math.round(numeric * multiplier);
  if (!Number.isSafeInteger(result) || (!allowZero && result <= 0)) return null;
  return result;
}

function parseKills(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
}

function hasDeltaRole(interaction) {
  const memberRoles = interaction.member?.roles;
  return Boolean(
    memberRoles?.cache?.has?.(DELTA_ROLE_ID)
    || (Array.isArray(memberRoles) && memberRoles.includes(DELTA_ROLE_ID))
  );
}

async function denyIfNoAccess(interaction) {
  if (interaction.guildId && hasDeltaRole(interaction)) return false;
  const payload = {
    content: `❌ Ten panel jest tylko dla osób z rolą <@&${DELTA_ROLE_ID}>.`,
    flags: MessageFlags.Ephemeral
  };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
  return true;
}

function buildDeltaCommand() {
  return new SlashCommandBuilder()
    .setName('delta')
    .setDescription('Delta Force Operations — panel wyników')
    .addSubcommand(s => s
      .setName('panel')
      .setDescription('Wyślij panel WIN / LOSE / bilans / historia'));
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🎯 Delta Force — Operations Tracker')
    .setDescription([
      'Kliknij **WIN** albo **LOSE**, a bot otworzy formularz po meczu.',
      '',
      '**W formularzu podajesz:**',
      '• koszt wejścia / gearu',
      '• wartość wyniesionych rzeczy',
      '• match cost / dodatkowe koszty',
      '• mapę',
      '• liczbę killi',
      '',
      'Bot liczy: **netto = wyniesione − wejście − match cost**.',
      'Każdy gracz ma własną historię i własny bilans.'
    ].join('\n'))
    .setFooter({ text: 'Dostęp tylko dla roli Delta Force' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}win`).setLabel('WIN').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}loss`).setLabel('LOSE').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}balance`).setLabel('Mój bilans').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}history`).setLabel('Historia').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}undo`).setLabel('Cofnij ostatni').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildRaidModal(result) {
  const isWin = result === 'win';
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}modal:${result}`)
    .setTitle(isWin ? 'Delta Force — WIN' : 'Delta Force — LOSE');

  const entry = new TextInputBuilder()
    .setCustomId('entry_cost')
    .setLabel('Koszt wejścia / gearu')
    .setPlaceholder('np. 1200000 albo 1.2m')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const carry = new TextInputBuilder()
    .setCustomId('carry_out')
    .setLabel('Ile wyniosłeś')
    .setPlaceholder('np. 3100000 albo 3.1m; przy śmierci może być 0')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const matchCost = new TextInputBuilder()
    .setCustomId('match_cost')
    .setLabel('Match cost / dodatkowe koszty')
    .setPlaceholder('np. 150000 albo 150k; jeśli brak wpisz 0')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue('0')
    .setMaxLength(20);

  const map = new TextInputBuilder()
    .setCustomId('map_name')
    .setLabel('Mapa')
    .setPlaceholder('np. Zero Dam / Space City')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);

  const kills = new TextInputBuilder()
    .setCustomId('kills')
    .setLabel('Kille')
    .setPlaceholder('np. 7')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(3);

  modal.addComponents(
    new ActionRowBuilder().addComponents(entry),
    new ActionRowBuilder().addComponents(carry),
    new ActionRowBuilder().addComponents(matchCost),
    new ActionRowBuilder().addComponents(map),
    new ActionRowBuilder().addComponents(kills)
  );
  return modal;
}

function buildBalanceEmbed(interaction, db) {
  const stats = db.getDeltaStats(String(interaction.guildId), String(interaction.user.id));
  const rate = stats.total ? (stats.wins / stats.total * 100) : 0;
  const embed = new EmbedBuilder()
    .setTitle('📊 Delta Force — Twój bilans')
    .setDescription(`Statystyki dla **${interaction.user.displayName || interaction.user.username}**`)
    .addFields(
      { name: 'Operacje', value: String(stats.total), inline: true },
      { name: '✅ WIN', value: String(stats.wins), inline: true },
      { name: '❌ LOSE', value: String(stats.losses), inline: true },
      { name: 'Extraction rate', value: `${rate.toFixed(1)}%`, inline: true },
      { name: '📈 Dodatnie raidy', value: formatShort(stats.profitTotal), inline: true },
      { name: '📉 Ujemne raidy', value: formatShort(stats.lossTotal), inline: true },
      { name: '💰 NETTO', value: `**${formatShort(stats.netTotal)}**\n${formatMoney(stats.netTotal)}`, inline: false }
    )
    .setFooter({ text: 'Delta Force • ręczny tracker' })
    .setTimestamp();

  if (stats.total) {
    embed.addFields(
      { name: 'Najlepszy raid', value: formatShort(stats.bestRaid), inline: true },
      { name: 'Najgorszy raid', value: formatShort(stats.worstRaid), inline: true }
    );
  }
  return embed;
}

function buildHistoryEmbed(interaction, db, limit = 10) {
  const rows = db.listDeltaRaids(String(interaction.guildId), String(interaction.user.id), limit);
  if (!rows.length) return null;

  const lines = rows.map(r => {
    const parts = [`**${formatShort(r.amount)}**`];
    if (r.entryCost != null) parts.push(`wejście ${formatShort(r.entryCost).replace('+', '')}`);
    if (r.carryOutValue != null) parts.push(`wyniesione ${formatShort(r.carryOutValue).replace('+', '')}`);
    if (r.matchCost != null && Number(r.matchCost) > 0) parts.push(`match cost ${formatShort(r.matchCost).replace('+', '')}`);
    if (r.mapName) parts.push(r.mapName);
    if (r.kills != null) parts.push(`${r.kills} kills`);
    return `${r.result === 'win' ? '✅' : '❌'} ${parts.join(' • ')}`;
  });

  return new EmbedBuilder()
    .setTitle(`🧾 Delta Force — Twoje ostatnie ${rows.length} operacji`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Wpisy należą wyłącznie do Twojego konta Discord' });
}

async function handleDeltaInteraction(interaction, { db }) {
  const isDeltaChat = interaction.isChatInputCommand() && interaction.commandName === 'delta';
  const isDeltaButton = interaction.isButton() && String(interaction.customId || '').startsWith(PREFIX);
  const isDeltaModal = interaction.isModalSubmit() && String(interaction.customId || '').startsWith(`${PREFIX}modal:`);
  if (!isDeltaChat && !isDeltaButton && !isDeltaModal) return false;

  if (await denyIfNoAccess(interaction)) return true;

  if (isDeltaChat) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'panel') {
      await interaction.reply(buildPanel());
      return true;
    }
    return false;
  }

  if (isDeltaButton) {
    const action = interaction.customId.slice(PREFIX.length);
    if (action === 'win' || action === 'loss') {
      await interaction.showModal(buildRaidModal(action));
      return true;
    }

    if (action === 'balance') {
      await interaction.reply({ embeds: [buildBalanceEmbed(interaction, db)], flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === 'history') {
      const embed = buildHistoryEmbed(interaction, db, 10);
      if (!embed) {
        await interaction.reply({ content: 'Nie masz jeszcze zapisanych operacji Delta Force.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      return true;
    }

    if (action === 'undo') {
      const removed = db.removeLastDeltaRaid(String(interaction.guildId), String(interaction.user.id));
      if (!removed) {
        await interaction.reply({ content: 'Nie ma czego cofnąć.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({
          content: `✅ Cofnięto ostatni wpis: ${removed.result === 'win' ? 'WIN' : 'LOSE'} **${formatShort(removed.amount)}**.`,
          flags: MessageFlags.Ephemeral
        });
      }
      return true;
    }

    return false;
  }

  if (isDeltaModal) {
    const result = interaction.customId.endsWith(':win') ? 'win' : 'loss';
    const entryCost = parseMoney(interaction.fields.getTextInputValue('entry_cost'), { allowZero: false });
    const carryOutValue = parseMoney(interaction.fields.getTextInputValue('carry_out'), { allowZero: true });
    const matchCost = parseMoney(interaction.fields.getTextInputValue('match_cost'), { allowZero: true });
    const mapName = interaction.fields.getTextInputValue('map_name').trim();
    const killsRaw = interaction.fields.getTextInputValue('kills');
    const kills = parseKills(killsRaw);

    if (entryCost == null || carryOutValue == null || matchCost == null || (killsRaw.trim() && kills == null)) {
      await interaction.reply({
        content: '❌ Nieprawidłowe dane. Kwoty wpisuj np. `1200000`, `1.2m`, `450k`. Kille muszą być liczbą 0–999.',
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const netIncome = carryOutValue - entryCost - matchCost;
    if (!Number.isSafeInteger(netIncome)) {
      await interaction.reply({ content: '❌ Wynik przekracza obsługiwany zakres liczb.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const raid = db.addDeltaRaid({
      guildId: String(interaction.guildId),
      userId: String(interaction.user.id),
      result,
      amount: netIncome,
      entryCost,
      carryOutValue,
      matchCost,
      mapName: mapName || null,
      kills
    });

    const embed = new EmbedBuilder()
      .setTitle(`${result === 'win' ? '✅ WIN' : '❌ LOSE'} zapisany`)
      .setDescription(`Twój wynik netto: **${formatShort(raid.amount)}**`)
      .addFields(
        { name: 'Koszt wejścia', value: formatMoney(-raid.entryCost), inline: true },
        { name: 'Wyniesione', value: formatMoney(raid.carryOutValue), inline: true },
        { name: 'Match cost', value: formatMoney(-raid.matchCost), inline: true },
        { name: 'NETTO', value: `**${formatMoney(raid.amount)}**`, inline: false }
      )
      .setFooter({ text: `Delta Force • ${raid.id}` })
      .setTimestamp(new Date(raid.createdAt));

    if (raid.mapName) embed.addFields({ name: 'Mapa', value: raid.mapName, inline: true });
    if (raid.kills != null) embed.addFields({ name: 'Kille', value: String(raid.kills), inline: true });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}

module.exports = { buildDeltaCommand, handleDeltaInteraction };
