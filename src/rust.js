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
      teamInfo: null, teamContextId: null, teamStatus: 'CHECKING', teamError: null, teamStatusChangedAt: Date.now(),
      chatStatus: 'CHECKING', chatError: null,
      teamInfoDebugLogged: false, teamContextDebugLogged: false,
      eventPollTimer: null, eventPollInFlight: false, eventPrimed: false
    };
    this.sessions.set(account.id, session);

    rust.on('connected', () => {
      session.connected = true;
      session.connectedAt = Date.now();
      session.chatPrimed = false;
      session.chatStatus = 'CHECKING'; session.chatError = null;
      console.log(`[Rust+] connected: ${account.id} (${account.name || account.ip})`);
      session.teamStatus = 'CHECKING';
      session.teamError = null;
      // Team chat is independent from getTeamInfo(). This restores the polling
      // path that proved reliable in the earlier local version.
      this.#startChatPolling(session);
      this.#refreshTeamInfo(session).catch(() => {});
      this.#startTeamPolling(session);
      this.#startEventPolling(session);
    });

    rust.on('message', (message) => {
      const teamMessage = message?.broadcast?.teamMessage?.message;
      if (teamMessage) { session.chatStatus = 'AVAILABLE'; session.chatError = null; this.#onTeamMessage(session, teamMessage).catch(console.error); }
    });

    rust.on('disconnected', () => {
      session.connected = false;
      session.teamInfo = null;
      session.teamContextId = null;
      session.teamStatus = 'DISCONNECTED';
      session.teamError = null;
      session.chatStatus = 'DISCONNECTED'; session.chatError = null;
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
  refreshRouting() { this.#rebuildTeams(); return this.listTeams(); }

  async diagnoseAccount(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw new Error('Konto Rust+ nie jest uruchomione.');
    if (!session.connected) return { accountId: String(id), connected: false, tests: {} };

    const tests = {};
    const run = async (name, fn) => {
      const started = Date.now();
      try {
        const value = await fn();
        tests[name] = { ok: true, ms: Date.now() - started, detail: value || null };
      } catch (err) {
        tests[name] = { ok: false, ms: Date.now() - started, error: this.#errorCode(err) || String(err?.message || err || 'unknown') };
      }
    };

    await run('getInfo', async () => {
      const r = await session.rust.sendRequestAsync({ getInfo: {} }, 5000);
      return r?.info ? { name: r.info.name || '', players: r.info.players ?? null } : null;
    });
    await run('getTime', async () => {
      const r = await session.rust.sendRequestAsync({ getTime: {} }, 5000);
      return r?.time ? { time: r.time.time } : null;
    });
    await run('getMapMarkers', async () => {
      const r = await session.rust.sendRequestAsync({ getMapMarkers: {} }, 5000);
      return { markers: r?.mapMarkers?.markers?.length || 0 };
    });
    await run('getTeamInfo', async () => {
      const r = await session.rust.sendRequestAsync({ getTeamInfo: {} }, 5000);
      return { members: r?.teamInfo?.members?.length || 0 };
    });
    await run('getTeamChat', async () => {
      const r = await session.rust.sendRequestAsync({ getTeamChat: {} }, 5000);
      return { messages: r?.teamChat?.messages?.length || 0 };
    });

    console.log(`[Rust+] diagnostics ${session.account.id}: ${JSON.stringify(tests)}`);
    return { accountId: session.account.id, connected: true, server: `${session.account.ip}:${session.account.port}`, tests };
  }

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
        teamSize: ctx?.memberSteamIds?.length || 0,
        teamStatus: s?.teamStatus || (s?.connected ? 'CHECKING' : 'DISCONNECTED'),
        teamError: s?.teamError || null,
        chatStatus: s?.chatStatus || (s?.connected ? 'CHECKING' : 'DISCONNECTED'),
        chatError: s?.chatError || null,
        routingMode: ctx?.mode || null,
        manualTeamName: ctx?.mode === 'manual' ? ctx.name : null
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
        updatedAt: ctx.updatedAt,
        mode: ctx.mode || 'auto',
        name: ctx.name || ctx.id,
        chatAvailable: ctx.activeAccountId ? this.sessions.get(ctx.activeAccountId)?.chatStatus === 'AVAILABLE' : false
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
    if (!session.connected || session.pollTimer) return;

    const poll = () => this.#pollTeamChat(session).catch((err) => {
      const code = this.#errorCode(err) || 'unknown';
      const previous = session.chatStatus;
      session.chatStatus = 'UNAVAILABLE';
      session.chatError = code;

      // Chat availability is deliberately independent from TeamInfo. A server can
      // return not_found for getTeamInfo while getTeamChat still works.
      if (previous !== 'UNAVAILABLE') {
        console.log(`[Rust+] team-chat status ${session.account.id}: UNAVAILABLE (${code})`);
        this.#rebuildTeams();
      }

      const now = Date.now();
      if (code !== 'not_found' && now - session.lastPollErrorAt > 60000) {
        session.lastPollErrorAt = now;
        console.error(`[Rust+] team-chat poll failed (${session.account.id}):`, err?.message || err);
      }
      // Do NOT stop polling. Team chat may become available later after a team
      // change, reconnect or delayed Companion state update.
    });

    poll();
    session.pollTimer = setInterval(poll, this.chatPollMs);
    console.log(`[Rust+] team-chat polling enabled: ${session.account.id} (${this.chatPollMs} ms, independent mode)`);
  }
  #stopChatPolling(session) { if (session.pollTimer) clearInterval(session.pollTimer); session.pollTimer = null; session.pollInFlight = false; }

  #startTeamPolling(session) {
    this.#stopTeamPolling(session);
    const poll = () => this.#refreshTeamInfo(session).catch((err) => {
      const code = this.#errorCode(err);
      if (code === 'not_found') return;
      const now = Date.now();
      if (!session.lastTeamErrorAt || now - session.lastTeamErrorAt > 60000) {
        session.lastTeamErrorAt = now;
        console.error(`[Rust+] team-info failed (${session.account.id}):`, err?.message || err);
      }
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

  #errorCode(err) {
    if (!err) return '';
    return String(err.error || err.code || err.message || err).toLowerCase();
  }

  #setTeamState(session, status, error = null) {
    const changed = session.teamStatus !== status || session.teamError !== error;
    session.teamStatus = status;
    session.teamError = error;
    if (changed) {
      session.teamStatusChangedAt = Date.now();
      const suffix = error ? ` (${error})` : '';
      console.log(`[Rust+] team status ${session.account.id}: ${status}${suffix}`);
    }
  }

  #requestTeamInfo(session, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('team_info_timeout'));
      }, timeoutMs);
      try {
        session.rust.getTeamInfo((message) => {
          if (settled) return true;
          settled = true;
          clearTimeout(timer);
          const response = message?.response;
          if (!response) return reject(new Error('team_info_empty_response'));
          if (response.error) return reject(response.error);
          if (!response.teamInfo) return reject(new Error('team_info_missing_payload'));
          resolve({ info: response.teamInfo, raw: message });
          return true;
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  async #requestTeamChat(session, timeoutMs = 5000) {
    // rustplus.js sendRequestAsync resolves directly to AppResponse. This is the
    // same path used by the earlier local build where in-game chat worked.
    const response = await session.rust.sendRequestAsync({ getTeamChat: {} }, timeoutMs);
    if (!response) throw new Error('team_chat_empty_response');
    if (response.error) throw response.error;
    return response.teamChat || { messages: [] };
  }

  async #refreshTeamInfo(session) {
    if (!session.connected || session.teamPollInFlight || !this.sessions.has(session.account.id)) return;
    session.teamPollInFlight = true;
    try {
      const { info, raw } = await this.#requestTeamInfo(session, 5000);
      const members = (info.members || []).map((m) => ({ ...m, steamId: String(m.steamId) }));
      const memberSteamIds = uniqSorted(members.map((m) => m.steamId).filter(Boolean));
      if (!memberSteamIds.length) throw new Error('team_info_empty_members');

      session.teamInfo = {
        leaderSteamId: String(info.leaderSteamId || ''),
        members,
        memberSteamIds
      };
      this.#setTeamState(session, 'TEAM_OK', null);
      if (!session.teamInfoDebugLogged) {
        session.teamInfoDebugLogged = true;
        console.log(`[Rust+] team-info OK (${session.account.id}): leader=${session.teamInfo.leaderSteamId || '-'} members=${memberSteamIds.length}`);
        if (process.env.RUST_TEAM_DEBUG === 'true') {
          const safe = { responseKeys: Object.keys(raw?.response || {}), leaderSteamId: session.teamInfo.leaderSteamId, memberSteamIds };
          console.log(`[Rust+] team-info diagnostic (${session.account.id}): ${JSON.stringify(safe)}`);
        }
      }
      this.#rebuildTeams();
      this.#startChatPolling(session);
    } catch (err) {
      const code = this.#errorCode(err);
      session.teamInfo = null;
      this.#setTeamState(session, code === 'not_found' ? 'NO_TEAM' : 'TEAM_API_ERROR', code || 'unknown');
      this.#rebuildTeams();
      // TeamInfo failure must never disable team-chat polling.
      this.#startChatPolling(session);
      if (code === 'not_found') return;
      throw err;
    } finally { session.teamPollInFlight = false; }
  }

  #serverKey(session) { return `${session.account.ip}:${session.account.port}`; }

  #rebuildTeams() {
    const oldContexts = new Map(this.teamContexts);
    const nextContexts = new Map();
    const manuallyAssigned = new Set();

    // 1) Manual teams always win over auto detection. This is the fallback for servers
    // where Companion returns not_found for getTeamInfo/getTeamChat discovery.
    for (const manual of this.db.listManualTeams()) {
      const sessions = (manual.accountIds || []).map((id) => this.sessions.get(id)).filter(Boolean);
      for (const sess of sessions) manuallyAssigned.add(sess.account.id);
      const serverKeys = [...new Set(sessions.map((x) => this.#serverKey(x)))];
      const serverKey = serverKeys.length === 1 ? serverKeys[0] : (serverKeys.length ? 'MULTI-SERVER (invalid)' : '-');
      const connected = sessions.filter((x) => x.connected);
      let activeId = manual.activeAccountId;
      const currentActive = activeId ? connected.find((x) => x.account.id === activeId) : null;
      const preferred = connected.filter((x) => x.chatStatus !== 'UNAVAILABLE');
      const pool = preferred.length ? preferred : connected;
      const activeValid = currentActive && (currentActive.chatStatus !== 'UNAVAILABLE' || preferred.length === 0);
      if (!activeValid) {
        const candidate = pool.sort((a,b) => {
          const rank=(x)=>x.chatStatus==='AVAILABLE'?0:x.chatStatus==='CHECKING'?1:2;
          return rank(a)-rank(b) || (a.connectedAt||0)-(b.connectedAt||0) || a.account.id.localeCompare(b.account.id);
        })[0];
        activeId = candidate?.account.id || null;
        if (activeId !== manual.activeAccountId) this.db.setManualTeamActive(manual.id, activeId);
        if (activeId) console.log(`[Teams] ${manual.id} ACTIVE -> ${activeId} (manual)`);
      }
      const previous = oldContexts.get(manual.id);
      const ctx = {
        ...(previous || {}), id: manual.id, name: manual.name, mode: 'manual', serverKey,
        memberSteamIds: uniqSorted(sessions.map((x) => x.account.playerId)), leaderSteamId: '',
        sessionIds: sessions.map((x) => x.account.id), activeAccountId: activeId,
        createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(),
        eventState: previous?.eventState || {}, eventPrimed: previous?.eventPrimed || false
      };
      nextContexts.set(ctx.id, ctx);
      for (const sess of sessions) sess.teamContextId = ctx.id;
    }

    // 2) Auto teams for accounts not manually assigned.
    const groups = new Map();
    for (const session of this.sessions.values()) {
      if (manuallyAssigned.has(session.account.id)) continue;
      if (!session.connected || !session.teamInfo?.memberSteamIds?.length) continue;
      const rosterKey = session.teamInfo.memberSteamIds.join(',');
      const key = `${this.#serverKey(session)}|${rosterKey}`;
      if (!groups.has(key)) groups.set(key, { serverKey:this.#serverKey(session), memberSteamIds:session.teamInfo.memberSteamIds, leaderSteamId:session.teamInfo.leaderSteamId, sessions:[] });
      groups.get(key).sessions.push(session);
    }

    const oldAuto = [...oldContexts.values()].filter((x) => x.mode !== 'manual');
    const usedOld = new Set();
    const sortedGroups = [...groups.values()].sort((a,b) => b.memberSteamIds.length-a.memberSteamIds.length);
    for (const group of sortedGroups) {
      let best=null,bestScore=0;
      for (const old of oldAuto) {
        if (usedOld.has(old.id) || old.serverKey !== group.serverKey) continue;
        const inter=intersectionSize(old.memberSteamIds, group.memberSteamIds); if(!inter) continue;
        let score=inter*100;
        if(inter>=2 && old.activeAccountId){ const active=this.sessions.get(old.activeAccountId); if(active && group.memberSteamIds.includes(String(active.account.playerId))) score+=20; }
        if(old.leaderSteamId && old.leaderSteamId===group.leaderSteamId) score+=10;
        if(score>bestScore){best=old;bestScore=score;}
      }
      const ctx=best?{...best}:{id:`team-${this.nextTeamId++}`,createdAt:Date.now(),activeAccountId:null,eventState:{},eventPrimed:false,mode:'auto'};
      if(best) usedOld.add(best.id);
      ctx.mode='auto'; ctx.name=ctx.id; ctx.serverKey=group.serverKey; ctx.memberSteamIds=[...group.memberSteamIds]; ctx.leaderSteamId=group.leaderSteamId; ctx.sessionIds=group.sessions.map((x)=>x.account.id); ctx.updatedAt=Date.now();
      const valid=ctx.activeAccountId && ctx.sessionIds.includes(ctx.activeAccountId) && this.sessions.get(ctx.activeAccountId)?.connected;
      if(!valid){ const c=[...group.sessions].filter((x)=>x.connected).sort((a,b)=>(a.connectedAt||0)-(b.connectedAt||0)||a.account.id.localeCompare(b.account.id))[0]; const prev=ctx.activeAccountId; ctx.activeAccountId=c?.account.id||null; if(ctx.activeAccountId&&prev!==ctx.activeAccountId) console.log(`[Teams] ${ctx.id} ACTIVE -> ${ctx.activeAccountId}`); }
      nextContexts.set(ctx.id,ctx); for(const sess of group.sessions) sess.teamContextId=ctx.id;
    }

    for (const sess of this.sessions.values()) {
      if (![...nextContexts.values()].some((ctx)=>ctx.sessionIds.includes(sess.account.id))) sess.teamContextId=null;
    }
    this.teamContexts=nextContexts;

    // Manual groups may poll team chat even when TeamInfo API says NO_TEAM.
    for (const ctx of this.teamContexts.values()) if (ctx.mode === 'manual') {
      for (const id of ctx.sessionIds) {
        const sess=this.sessions.get(id); if(sess?.connected && !sess.pollTimer) this.#startChatPolling(sess);
      }
    }
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
      const teamChat = await this.#requestTeamChat(session, 5000);
      const changed = session.chatStatus !== 'AVAILABLE';
      session.chatStatus = 'AVAILABLE'; session.chatError = null;
      if (changed) {
        console.log(`[Rust+] team-chat status ${session.account.id}: AVAILABLE`);
        this.#rebuildTeams();
      }
      const messages = teamChat?.messages || [];
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
