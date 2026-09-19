const RustPlus = require('@liamcottle/rustplus.js');
const { handleRustCommand, MARKER } = require('./commands');

function uniqSorted(values) { return [...new Set(values.map(String))].sort(); }
function intersectionSize(a, b) {
  const set = new Set(a);
  let n = 0;
  for (const x of b) if (set.has(x)) n++;
  return n;
}

class RustManager {
  constructor({ db, discord, prefix, chatPollMs = 2500, teamInfoPollMs = 10000, eventPollMs = 15000, eventAlertsEnabled = true }) {
    this.db = db;
    this.discord = discord;
    this.prefix = prefix;
    this.chatPollMs = Math.max(1500, Number(chatPollMs) || 2500);
    this.teamInfoPollMs = Math.max(5000, Number(teamInfoPollMs) || 10000);
    this.eventPollMs = Math.max(5000, Number(eventPollMs) || 15000);
    this.eventAlertsEnabled = Boolean(eventAlertsEnabled);
    this.commandCooldowns = new Map();
    this.sessions = new Map();
    this.teamContexts = new Map();
    this.nextTeamId = 1;
  }

  startAll() { for (const account of this.db.listRustAccounts()) this.start(account); }

  start(account) {
    this.stop(account.id);
    const rust = new RustPlus(account.ip, String(account.port), String(account.playerId), Number(account.playerToken));
    const session = {
      account, rust, connected: false, connectedAt: 0, reconnectTimer: null,
      pollTimer: null, teamPollTimer: null, pollInFlight: false, teamPollInFlight: false,
      chatPrimed: false, recentMessages: new Set(), lastPollErrorAt: 0,
      teamInfo: null, teamContextId: null, eventPollTimer: null, eventPollInFlight: false, eventPrimed: false
    };
    this.sessions.set(account.id, session);

    rust.on('connected', () => {
      session.connected = true;
      session.connectedAt = Date.now();
      session.chatPrimed = false;
      console.log(`[Rust+] connected: ${account.id} (${account.name || account.ip})`);
      this.#refreshTeamInfo(session).catch(() => {});
      this.#startTeamPolling(session);
      this.#startChatPolling(session);
      this.#startEventPolling(session);
    });

    rust.on('message', (message) => {
      const teamMessage = message?.broadcast?.teamMessage?.message;
      if (teamMessage) this.#onTeamMessage(session, teamMessage).catch(console.error);
    });

    rust.on('disconnected', () => {
      session.connected = false;
      session.teamInfo = null;
      session.teamContextId = null;
      this.#stopChatPolling(session);
      this.#stopTeamPolling(session);
      this.#stopEventPolling(session);
      this.#rebuildTeams();
      console.log(`[Rust+] disconnected: ${account.id}`);
      this.#scheduleReconnect(session);
    });

    rust.on('error', (err) => console.error(`[Rust+] error (${account.id}):`, err?.message || err));
    rust.connect();
    return session;
  }

  stop(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    this.#stopChatPolling(session);
    this.#stopTeamPolling(session);
    this.#stopEventPolling(session);
    try { session.rust.disconnect(); } catch (_) {}
    this.sessions.delete(id);
    this.#rebuildTeams();
  }

  restart(id) { const a = this.db.getRustAccount(id); if (!a) return false; this.start(a); return true; }

  listStatus() {
    return this.db.listRustAccounts().map((account) => {
      const s = this.sessions.get(account.id);
      const ctx = s?.teamContextId ? this.teamContexts.get(s.teamContextId) : null;
      return {
        ...account,
        playerToken: undefined,
        connected: Boolean(s?.connected),
        teamId: ctx?.id || null,
        senderRole: ctx ? (ctx.activeAccountId === account.id ? 'ACTIVE' : 'BACKUP') : 'UNASSIGNED',
        teamSize: ctx?.memberSteamIds?.length || 0
      };
    });
  }

  listTeams() {
    return [...this.teamContexts.values()]
      .filter((ctx) => ctx.sessionIds.length)
      .map((ctx) => ({
        id: ctx.id,
        serverKey: ctx.serverKey,
        leaderSteamId: ctx.leaderSteamId,
        memberSteamIds: [...ctx.memberSteamIds],
        activeAccountId: ctx.activeAccountId,
        accountIds: [...ctx.sessionIds],
        updatedAt: ctx.updatedAt
      }));
  }

  #scheduleReconnect(session) {
    if (!this.sessions.has(session.account.id) || session.reconnectTimer) return;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (this.sessions.has(session.account.id)) {
        console.log(`[Rust+] reconnecting: ${session.account.id}`);
        try { session.rust.connect(); } catch (err) { console.error(err); }
      }
    }, 15000);
  }

  #startChatPolling(session) {
    this.#stopChatPolling(session);
    const poll = () => this.#pollTeamChat(session).catch((err) => {
      const now = Date.now();
      if (now - session.lastPollErrorAt > 15000) {
        session.lastPollErrorAt = now;
        console.error(`[Rust+] team-chat poll failed (${session.account.id}):`, err?.message || err);
      }
    });
    poll();
    session.pollTimer = setInterval(poll, this.chatPollMs);
    console.log(`[Rust+] team-chat polling enabled: ${session.account.id} (${this.chatPollMs} ms)`);
  }
  #stopChatPolling(session) { if (session.pollTimer) clearInterval(session.pollTimer); session.pollTimer = null; session.pollInFlight = false; }

  #startTeamPolling(session) {
    this.#stopTeamPolling(session);
    const poll = () => this.#refreshTeamInfo(session).catch((err) => {
      console.error(`[Rust+] team-info failed (${session.account.id}):`, err?.message || err);
    });
    session.teamPollTimer = setInterval(poll, this.teamInfoPollMs);
  }
  #stopTeamPolling(session) { if (session.teamPollTimer) clearInterval(session.teamPollTimer); session.teamPollTimer = null; session.teamPollInFlight = false; }

  #startEventPolling(session) {
    this.#stopEventPolling(session);
    if (!this.eventAlertsEnabled) return;
    const poll = () => this.#pollEvents(session).catch((err) => {
      console.error(`[Rust+] event poll failed (${session.account.id}):`, err?.message || err);
    });
    poll();
    session.eventPollTimer = setInterval(poll, this.eventPollMs);
  }

  #stopEventPolling(session) {
    if (session.eventPollTimer) clearInterval(session.eventPollTimer);
    session.eventPollTimer = null;
    session.eventPollInFlight = false;
    session.eventPrimed = false;
  }

  async #pollEvents(session) {
    if (!session.connected || session.eventPollInFlight || !this.#isActiveSender(session)) return;
    session.eventPollInFlight = true;
    try {
      const response = await session.rust.sendRequestAsync({ getMapMarkers: {} }, 5000);
      const markers = response?.mapMarkers?.markers || [];
      const current = {
        cargo: markers.some((m) => Number(m.type) === MARKER.CARGO),
        heli: markers.some((m) => Number(m.type) === MARKER.PATROL_HELI),
        chinook: markers.some((m) => Number(m.type) === MARKER.CH47),
        crate: markers.some((m) => Number(m.type) === MARKER.CRATE)
      };
      const ctx = this.teamContexts.get(session.teamContextId);
      if (!ctx) return;
      if (!ctx.eventState) ctx.eventState = {};
      if (!ctx.eventPrimed) {
        ctx.eventState = current;
        ctx.eventPrimed = true;
        return;
      }
      const defs = {
        cargo: ['🚢 Cargo Ship pojawił się na mapie!', '🚢 Cargo Ship zniknął z mapy.'],
        heli: ['🚁 Patrol Helicopter pojawił się!', '🚁 Patrol Helicopter zniknął.'],
        chinook: ['🚁 CH47/Chinook pojawił się!', '🚁 CH47/Chinook zniknął.'],
        crate: ['📦 Locked Crate pojawiła się!', '📦 Locked Crate zniknęła.']
      };
      for (const [key, now] of Object.entries(current)) {
        const before = Boolean(ctx.eventState[key]);
        if (before === now) continue;
        ctx.eventState[key] = now;
        const msg = defs[key][now ? 0 : 1];
        try { session.rust.sendTeamMessage(msg); } catch (_) {}
        this.discord.sendAlert(`[${session.account.name || ctx.serverKey}] ${msg}`).catch(() => {});
        console.log(`[Events] ${ctx.id}: ${msg}`);
      }
    } finally { session.eventPollInFlight = false; }
  }

  async #refreshTeamInfo(session) {
    if (!session.connected || session.teamPollInFlight || !this.sessions.has(session.account.id)) return;
    session.teamPollInFlight = true;
    try {
      const response = await session.rust.sendRequestAsync({ getTeamInfo: {} }, 5000);
      const info = response?.teamInfo;
      if (!info) throw new Error('Brak teamInfo w odpowiedzi Rust+.');
      const members = (info.members || []).map((m) => ({ ...m, steamId: String(m.steamId) }));
      session.teamInfo = {
        leaderSteamId: String(info.leaderSteamId || ''),
        members,
        memberSteamIds: uniqSorted(members.map((m) => m.steamId))
      };
      this.#rebuildTeams();
    } finally { session.teamPollInFlight = false; }
  }

  #serverKey(session) { return `${session.account.ip}:${session.account.port}`; }

  #rebuildTeams() {
    const groups = new Map();
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.teamInfo?.memberSteamIds?.length) continue;
      const rosterKey = session.teamInfo.memberSteamIds.join(',');
      const key = `${this.#serverKey(session)}|${rosterKey}`;
      if (!groups.has(key)) groups.set(key, {
        serverKey: this.#serverKey(session),
        memberSteamIds: session.teamInfo.memberSteamIds,
        leaderSteamId: session.teamInfo.leaderSteamId,
        sessions: []
      });
      groups.get(key).sessions.push(session);
    }

    const oldContexts = [...this.teamContexts.values()];
    const usedOld = new Set();
    const nextContexts = new Map();
    const sortedGroups = [...groups.values()].sort((a, b) => b.memberSteamIds.length - a.memberSteamIds.length);

    for (const group of sortedGroups) {
      let best = null;
      let bestScore = 0;
      for (const old of oldContexts) {
        if (usedOld.has(old.id) || old.serverKey !== group.serverKey) continue;
        const inter = intersectionSize(old.memberSteamIds, group.memberSteamIds);
        if (!inter) continue;
        let score = inter * 100;
        if (inter >= 2 && old.activeAccountId) {
          const active = this.sessions.get(old.activeAccountId);
          if (active && group.memberSteamIds.includes(String(active.account.playerId))) score += 20;
        }
        if (old.leaderSteamId && old.leaderSteamId === group.leaderSteamId) score += 10;
        if (score > bestScore) { best = old; bestScore = score; }
      }

      const ctx = best ? { ...best } : {
        id: `team-${this.nextTeamId++}`,
        createdAt: Date.now(),
        activeAccountId: null,
        eventState: {},
        eventPrimed: false
      };
      if (best) usedOld.add(best.id);
      ctx.serverKey = group.serverKey;
      ctx.memberSteamIds = [...group.memberSteamIds];
      ctx.leaderSteamId = group.leaderSteamId;
      ctx.sessionIds = group.sessions.map((s) => s.account.id);
      ctx.updatedAt = Date.now();

      const activeStillValid = ctx.activeAccountId && ctx.sessionIds.includes(ctx.activeAccountId) && this.sessions.get(ctx.activeAccountId)?.connected;
      if (!activeStillValid) {
        const candidate = [...group.sessions]
          .filter((s) => s.connected)
          .sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0) || a.account.id.localeCompare(b.account.id))[0];
        const previous = ctx.activeAccountId;
        ctx.activeAccountId = candidate?.account.id || null;
        if (ctx.activeAccountId && previous !== ctx.activeAccountId) {
          console.log(`[Teams] ${ctx.id} ACTIVE -> ${ctx.activeAccountId}`);
        }
      }

      nextContexts.set(ctx.id, ctx);
      for (const s of group.sessions) s.teamContextId = ctx.id;
    }

    for (const s of this.sessions.values()) {
      if (![...nextContexts.values()].some((ctx) => ctx.sessionIds.includes(s.account.id))) s.teamContextId = null;
    }
    this.teamContexts = nextContexts;
  }

  #isActiveSender(session) {
    if (!session.teamContextId) return false;
    const ctx = this.teamContexts.get(session.teamContextId);
    return Boolean(ctx && ctx.activeAccountId === session.account.id);
  }

  async #pollTeamChat(session) {
    if (!session.connected || session.pollInFlight || !this.sessions.has(session.account.id)) return;
    session.pollInFlight = true;
    try {
      const response = await session.rust.sendRequestAsync({ getTeamChat: {} }, 5000);
      const messages = response?.teamChat?.messages || [];
      if (!session.chatPrimed) {
        for (const m of messages) this.#rememberMessage(session, m);
        session.chatPrimed = true;
        console.log(`[Rust+] team-chat ready: ${session.account.id} (${messages.length} history messages ignored)`);
        return;
      }
      for (const m of messages) await this.#onTeamMessage(session, m);
    } finally { session.pollInFlight = false; }
  }

  #messageKey(m) { return `${String(m?.steamId || '')}:${String(m?.time ?? '')}:${String(m?.message || '')}`; }
  #rememberMessage(session, m) {
    const key = this.#messageKey(m);
    if (!key || session.recentMessages.has(key)) return false;
    session.recentMessages.add(key);
    while (session.recentMessages.size > 300) session.recentMessages.delete(session.recentMessages.values().next().value);
    return true;
  }

  async #onTeamMessage(session, teamMessage) {
    if (!this.#rememberMessage(session, teamMessage)) return;
    const text = String(teamMessage.message || '').trim();
    const steamId = String(teamMessage.steamId || '');
    if (!text.startsWith(this.prefix) || !steamId) return;
    if (!this.#isActiveSender(session)) return;

    const [rawCommand, ...args] = text.slice(this.prefix.length).trim().split(/\s+/);
    const command = rawCommand?.toLowerCase();
    if (!command) return;
    const cooldownKey = `${session.teamContextId}:${steamId}`;
    const now = Date.now();
    const last = this.commandCooldowns.get(cooldownKey) || 0;
    if (now - last < 1500) return;
    this.commandCooldowns.set(cooldownKey, now);
    console.log(`[Rust+] command (${session.account.id}/${session.teamContextId}) ${steamId}: ${this.prefix}${command}`);

    try {
      const reply = await handleRustCommand({
        rust: session.rust, command, args,
        isAuthorized: () => this.#isSteamAuthorized(steamId),
        linkHandler: (code) => this.#linkSteam(steamId, code)
      });
      if (reply) session.rust.sendTeamMessage(String(reply).slice(0, 500));
    } catch (err) {
      console.error(`[Rust+] command failed (${command}):`, err?.message || err);
      session.rust.sendTeamMessage('❌ Nie udało się wykonać komendy. Spróbuj ponownie.');
    }
  }

  async #isSteamAuthorized(steamId) {
    const discordId = this.db.getDiscordIdBySteamId(steamId);
    if (!discordId) return false;
    return this.discord.hasAccessRole(discordId);
  }

  async #linkSteam(steamId, code) {
    if (!/^\d{6}$/.test(String(code || ''))) return '❌ Użycie: !link 123456';
    const result = this.db.consumeLinkCode(String(code), steamId);
    if (!result.ok) return result.reason === 'expired' ? '❌ Kod wygasł. Wygeneruj nowy przez /link na Discordzie.' : '❌ Nieprawidłowy kod linkowania.';
    const hasRole = await this.discord.hasAccessRole(result.discordId);
    return hasRole ? '✅ Steam połączony z Discordem. Dostęp aktywny.' : '✅ Steam połączony, ale nie masz wymaganej roli Discord.';
  }
}

module.exports = { RustManager };
