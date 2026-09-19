const express = require('express');
const crypto = require('node:crypto');

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

class WebPanel {
  constructor({ config, db, discord, rustManager, pairingManager }) {
    this.config = config;
    this.db = db;
    this.discord = discord;
    this.rustManager = rustManager;
    this.pairing = pairingManager;
    this.app = express();
    this.sessions = new Map();
    this.oauthStates = new Map();
  }

  start() {
    if (!this.config.webEnabled) {
      console.log('[Web] disabled (set BASE_URL, DISCORD_CLIENT_SECRET and SESSION_SECRET to enable)');
      return null;
    }
    this.app.use(express.urlencoded({ extended: false }));
    this.app.use(express.json({ limit: '128kb' }));
    this.app.get('/health', (_, res) => res.json({ ok: true, version: '0.4.2' }));
    this.app.get('/', (req, res) => this.#home(req, res));
    this.app.get('/auth/discord', (req, res) => this.#login(req, res));
    this.app.get('/auth/discord/callback', (req, res) => this.#callback(req, res));
    this.app.post('/logout', (req, res) => this.#logout(req, res));

    this.app.post('/pairing/start', (req, res) => this.#pairStart(req, res));
    this.app.post('/pairing/import', (req, res) => this.#pairImport(req, res));
    this.app.get('/pairing/status', (req, res) => this.#pairStatus(req, res));
    this.app.post('/pairing/cancel', (req, res) => this.#pairCancel(req, res));
    this.app.post('/api/pairing/:code/complete', (req, res) => this.#pairApiComplete(req, res));

    this.app.post('/account/add', (req, res) => this.#addAccount(req, res));
    this.app.post('/account/remove', (req, res) => this.#removeAccount(req, res));
    this.server = this.app.listen(this.config.port, '0.0.0.0', () => console.log(`[Web] listening on :${this.config.port}`));
    return this.server;
  }

  stop() { try { this.server?.close(); } catch (_) {} }

  #session(req) {
    const raw = parseCookies(req).rh_session; if (!raw) return null;
    const [id, sig] = raw.split('.'); if (!id || !sig || hmac(this.config.sessionSecret, id) !== sig) return null;
    const s = this.sessions.get(id); if (!s || s.expiresAt < Date.now()) { this.sessions.delete(id); return null; }
    return s;
  }
  #setSession(res, user) {
    const id = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(id, { user, expiresAt: Date.now() + 7 * 86400_000 });
    const secure = this.config.baseUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rh_session=${id}.${hmac(this.config.sessionSecret, id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
  }
  #clearSession(res) { res.setHeader('Set-Cookie', 'rh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }

  #layout(title, body, user = null, script = '') {
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
    :root{color-scheme:dark}body{margin:0;background:#0e1116;color:#e8edf2;font:15px system-ui,Segoe UI,sans-serif}.wrap{max-width:1000px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.card{background:#171c23;border:1px solid #2a323d;border-radius:14px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.muted{color:#9ca9b8}.ok{color:#69d58c}.warn{color:#f0c86a}.bad{color:#ff7777}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#252d38;margin:2px}input,textarea{width:100%;box-sizing:border-box;background:#0e1319;color:#fff;border:1px solid #394454;border-radius:8px;padding:10px;margin:5px 0 12px}textarea{min-height:150px;resize:vertical}button,.btn{background:#5865f2;color:#fff;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;cursor:pointer;display:inline-block}.secondary{background:#343d49}.danger{background:#aa3d48}code{background:#0d1218;padding:2px 5px;border-radius:5px;word-break:break-all}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.steps{display:grid;gap:8px;margin:12px 0}.step{padding:10px 12px;border-radius:9px;background:#10151b;border:1px solid #29323e}details{margin-top:14px}h1,h2,h3{margin:.3em 0}.codebox{font-size:22px;letter-spacing:2px;font-weight:700}.notice{border-left:4px solid #f0c86a;padding-left:12px}</style></head><body><div class="wrap"><div class="top"><h1>Rust Helper</h1>${user ? `<div class="row"><span>${esc(user.username)}</span><form method="post" action="/logout"><button>Wyloguj</button></form></div>` : ''}</div>${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
  }

  async #home(req, res) {
    const session = this.#session(req);
    if (!session) return res.send(this.#layout('Rust Helper', `<div class="card"><h2>Panel Rust Helper</h2><p class="muted">Zaloguj się przez Discord, aby zarządzać swoim Rust+.</p><a class="btn" href="/auth/discord">Zaloguj przez Discord</a></div>`));
    const user = session.user;
    const hasRole = await this.discord.hasAccessRole(user.id);
    const isAdmin = this.discord.isAdmin(user.id);
    const steamId = this.db.getSteamIdByDiscordId(user.id);
    const pairState = this.pairing.status(user.id);
    const statuses = this.rustManager.listStatus();
    const visible = isAdmin ? statuses : statuses.filter((a) => a.ownerDiscordId === user.id || String(a.playerId) === String(steamId || ''));
    const teams = this.rustManager.listTeams();

    const accountsHtml = visible.length ? visible.map((a) => {
      const teamLabel = a.teamStatus === 'TEAM_OK' ? (a.teamId || 'TEAM OK') : a.teamStatus === 'NO_TEAM' ? 'NO TEAM' : a.teamStatus === 'TEAM_API_ERROR' ? 'TEAM API ERROR' : a.teamStatus === 'CHECKING' ? 'CHECKING TEAM' : 'UNASSIGNED';
      const teamClass = a.teamStatus === 'TEAM_OK' ? 'ok' : a.teamStatus === 'NO_TEAM' ? 'warn' : a.teamStatus === 'TEAM_API_ERROR' ? 'bad' : '';
      const detail = a.teamStatus === 'TEAM_API_ERROR' && a.teamError ? ` · błąd: ${esc(a.teamError)}` : '';
      return `<div class="card"><div class="row"><strong>${esc(a.name)}</strong><span class="pill ${a.connected?'ok':'bad'}">${a.connected?'CONNECTED':'OFFLINE'}</span><span class="pill ${teamClass}">${esc(teamLabel)}</span><span class="pill">${esc(a.senderRole)}</span></div><div class="muted">${esc(a.ip)}:${esc(a.port)} · Steam ${esc(a.playerId)}${detail}</div><form method="post" action="/account/remove" onsubmit="return confirm('Usunąć konto?')"><input type="hidden" name="id" value="${esc(a.id)}"><button class="danger">Usuń</button></form></div>`;
    }).join('') : '<div class="card muted">Brak kont Rust+.</div>';
    const teamHtml = teams.length ? teams.map((t) => `<div class="card"><strong>${esc(t.id)}</strong> · ${esc(t.serverKey)}<div>ACTIVE: <code>${esc(t.activeAccountId || '-')}</code></div><div class="muted">Konta: ${t.accountIds.map(esc).join(', ')} · członkowie teamu: ${t.memberSteamIds.length}</div></div>`).join('') : '<div class="card muted">Brak wykrytych teamów.</div>';

    let pairingCard = '';
    if (!hasRole) {
      pairingCard = `<div class="card bad">Nie masz wymaganej roli Discord.</div>`;
    } else if (pairState.phase === 'waiting') {
      const expires = new Date(pairState.expiresAt).toLocaleTimeString('pl-PL', { hour:'2-digit', minute:'2-digit' });
      pairingCard = `<div class="card"><h2>Dodaj Rust+</h2><div id="pair-status"><span class="warn">Czekam na dane pairingu…</span></div><p>Twój jednorazowy kod:</p><div class="codebox"><code>${esc(pairState.code)}</code></div><p class="muted">Kod wygasa około ${esc(expires)}. Nie wpisujesz na naszej stronie loginu ani hasła Steam.</p><div class="notice"><b>Bezpieczny flow v0.4.1:</b> wykonaj oficjalny pairing Rust+ na swoim koncie i przekaż do panelu tylko wynik pairingu. Na dziś możesz wkleić cały JSON/tekst z <code>fcm-listen</code>. Późniejszy helper będzie mógł wysłać go automatycznie pod ten kod.</div><div class="steps"><div class="step">1. Na swoim PC uruchom <code>npx @liamcottle/rustplus.js fcm-listen</code> (po wcześniejszym jednorazowym <code>fcm-register</code>).</div><div class="step">2. W Rust kliknij <b>Pair with Server</b>.</div><div class="step">3. Skopiuj cały komunikat pairingowy z terminala i wklej poniżej. Nie musisz wyciągać pól ręcznie.</div></div><form method="post" action="/pairing/import"><textarea name="payload" placeholder='Wklej tutaj cały obiekt/JSON pairingu, np. zawierający ip, port, playerId, playerToken' required></textarea><button>Dodaj konto Rust+</button></form><form method="post" action="/pairing/cancel"><button class="secondary">Anuluj</button></form></div>`;
    } else if (pairState.phase === 'paired') {
      pairingCard = `<div class="card"><h2>Rust+ dodane ✅</h2><p>Serwer: <b>${esc(pairState.result?.name || 'Rust server')}</b></p><form method="post" action="/pairing/start"><button>Dodaj kolejne konto / serwer</button></form></div>`;
    } else {
      pairingCard = `<div class="card"><h2>Dodaj Rust+</h2><p>W v0.4.1 usunęliśmy niedziałające logowanie Steam przez stronę. Hasło Steam nigdy nie trafia do Rust Helper.</p><p class="muted">Panel generuje jednorazowy kod i przyjmuje wyłącznie dane pairingu Rust+. To działa stabilnie z obecnym procesem Rust+ i jest przygotowane pod przyszły one-click helper.</p><form method="post" action="/pairing/start"><button>Wygeneruj kod pairingu</button></form></div>`;
    }

    const manualForm = hasRole ? `<details class="card"><summary>Tryb awaryjny: wpisz pola ręcznie</summary><p class="muted">Użyj tylko jeśli parser całego komunikatu pairingu nie rozpozna danych.</p><form method="post" action="/account/add"><input name="name" placeholder="Nazwa, np. Medium III" required><input name="ip" placeholder="IP / hostname" required><input name="port" type="number" min="1" max="65535" placeholder="app.port" required><input name="playerId" placeholder="SteamID64" required><input name="playerToken" placeholder="playerToken" required><button>Dodaj konto ręcznie</button></form></details>` : '';

    const script = pairState.phase === 'waiting' ? `
      const statusEl=document.getElementById('pair-status');
      async function poll(){try{const r=await fetch('/pairing/status',{cache:'no-store'});const s=await r.json();if(s.phase==='paired'){statusEl.innerHTML='<span class="ok">✅ Serwer dodany: '+String(s.result?.name||'Rust server').replace(/[<>]/g,'')+'</span>';setTimeout(()=>location.reload(),1000);return;}if(s.phase==='idle'){statusEl.innerHTML='<span class="bad">Kod wygasł albo został anulowany.</span>';return;}setTimeout(poll,3000);}catch(e){setTimeout(poll,5000)}}poll();` : '';

    res.send(this.#layout('Rust Helper', `<div class="grid"><div class="card"><h3>Discord</h3><div>${esc(user.username)}</div><div>Rola dostępu: ${hasRole?'<span class="ok">TAK</span>':'<span class="bad">NIE</span>'}</div><div>Steam: ${steamId?`<code>${esc(steamId)}</code>`:'zostanie podpięty po dodaniu Rust+'}</div></div><div class="card"><h3>Routing teamów</h3><p class="muted">Jeden ACTIVE na team, reszta BACKUP. ACTIVE jest sticky i zmienia się tylko gdy wypada.</p></div></div>${pairingCard}${manualForm}<h2>Moje konta Rust+</h2>${accountsHtml}${isAdmin?`<h2>Teamy</h2>${teamHtml}`:''}`, user, script));
  }

  #login(req, res) {
    const state = crypto.randomBytes(18).toString('base64url');
    this.oauthStates.set(state, Date.now() + 10 * 60_000);
    const q = new URLSearchParams({ client_id: this.config.discordClientId, response_type: 'code', redirect_uri: `${this.config.baseUrl}/auth/discord/callback`, scope: 'identify', state });
    res.redirect(`https://discord.com/oauth2/authorize?${q}`);
  }

  async #callback(req, res) {
    try {
      const { code, state } = req.query;
      const expiry = this.oauthStates.get(String(state)); this.oauthStates.delete(String(state));
      if (!code || !expiry || expiry < Date.now()) throw new Error('Nieprawidłowy lub wygasły OAuth state.');
      const body = new URLSearchParams({ client_id: this.config.discordClientId, client_secret: this.config.discordClientSecret, grant_type: 'authorization_code', code: String(code), redirect_uri: `${this.config.baseUrl}/auth/discord/callback` });
      const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
      if (!tokenRes.ok) throw new Error(`Discord token exchange: ${tokenRes.status}`);
      const token = await tokenRes.json();
      const userRes = await fetch('https://discord.com/api/v10/users/@me', { headers:{ Authorization:`Bearer ${token.access_token}` } });
      if (!userRes.ok) throw new Error(`Discord user fetch: ${userRes.status}`);
      const user = await userRes.json();
      this.#setSession(res, { id: user.id, username: user.global_name || user.username, avatar: user.avatar });
      res.redirect('/');
    } catch (err) { console.error('[Web] OAuth error:', err); res.status(400).send(this.#layout('Błąd', `<div class="card bad">${esc(err.message)}</div>`)); }
  }

  #logout(req, res) {
    const s = this.#session(req);
    if (s) { for (const [id, entry] of this.sessions) if (entry === s) this.sessions.delete(id); }
    this.#clearSession(res); res.redirect('/');
  }

  async #pairStart(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
    if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
    this.pairing.createTicket(s.user.id);
    res.redirect('/');
  }

  #pairImport(req, res) {
    try {
      const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
      const ticket = this.pairing.getTicketForDiscord(s.user.id);
      if (!ticket) throw new Error('Najpierw wygeneruj kod pairingu.');
      this.pairing.completeTicket(ticket.code, String(req.body.payload || ''));
      res.redirect('/');
    } catch (err) { res.status(400).send(this.#layout('Błąd pairingu', `<div class="card bad">${esc(err.message)}</div><a class="btn" href="/">Wróć</a>`)); }
  }

  #pairStatus(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).json({ error: 'Unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(this.pairing.status(s.user.id));
  }

  #pairCancel(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
    this.pairing.cancel(s.user.id); res.redirect('/');
  }

  #pairApiComplete(req, res) {
    try {
      const result = this.pairing.completeTicket(String(req.params.code || ''), req.body);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }

  async #addAccount(req, res) {
    try {
      const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
      if (!(await this.discord.hasAccessRole(s.user.id))) return res.status(403).send('Brak wymaganej roli Discord.');
      const tokenRaw = String(req.body.playerToken || '').trim(); if (!/^-?\d+$/.test(tokenRaw)) throw new Error('playerToken musi być liczbą.');
      const playerId = String(req.body.playerId || '').trim(); if (!/^\d{16,20}$/.test(playerId)) throw new Error('Nieprawidłowe SteamID64.');
      const id = `web-${s.user.id}-${Date.now().toString(36)}`;
      const account = this.db.upsertRustAccount({ id, name:String(req.body.name||'Rust+').trim(), ip:String(req.body.ip||'').trim(), port:Number(req.body.port), playerId, playerToken:Number(tokenRaw), ownerDiscordId:s.user.id });
      this.db.linkSteamToDiscord(playerId, s.user.id);
      this.rustManager.start(account); res.redirect('/');
    } catch (err) { res.status(400).send(this.#layout('Błąd', `<div class="card bad">${esc(err.message)}</div><a class="btn" href="/">Wróć</a>`)); }
  }

  #removeAccount(req, res) {
    const s = this.#session(req); if (!s) return res.status(401).send('Unauthorized');
    const id = String(req.body.id || ''); const a = this.db.getRustAccount(id);
    if (!a || (!this.discord.isAdmin(s.user.id) && a.ownerDiscordId !== s.user.id)) return res.status(403).send('Forbidden');
    this.rustManager.stop(id); this.db.removeRustAccount(id); res.redirect('/');
  }
}

module.exports = { WebPanel };
