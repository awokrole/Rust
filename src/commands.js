const MARKER = { CH47: 4, CARGO: 5, CRATE: 6, PATROL_HELI: 8 };

const mapCache = new WeakMap();

async function requestAsync(rust, payload) { return rust.sendRequestAsync(payload, 5000); }

function formatGameTime(value) {
  const n = ((Number(value) % 24) + 24) % 24;
  const h = Math.floor(n), m = Math.floor((n - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function getMarkers(rust) {
  const r = await requestAsync(rust, { getMapMarkers: {} });
  return r?.mapMarkers?.markers || [];
}
function hasType(markers, type) { return markers.some((m) => Number(m.type) === type); }
function distance(a, b) { return Math.hypot(Number(a.x || 0) - Number(b.x || 0), Number(a.y || 0) - Number(b.y || 0)); }

async function getOilRigMonuments(rust) {
  const cached = mapCache.get(rust);
  if (cached?.oilRigs) return cached.oilRigs;
  const r = await requestAsync(rust, { getMap: {} });
  const monuments = r?.map?.monuments || [];
  const find = (token) => monuments.find((m) => String(m.token || '').toLowerCase() === token);
  const oilRigs = {
    large: find('oilrig_1') || null,
    small: find('oilrig_2') || null,
    width: Number(r?.map?.width || 0),
    height: Number(r?.map?.height || 0)
  };
  mapCache.set(rust, { oilRigs, loadedAt: Date.now() });
  return oilRigs;
}

async function getOilRigState(rust, markers = null) {
  const [m, rigs] = await Promise.all([markers ? Promise.resolve(markers) : getMarkers(rust), getOilRigMonuments(rust)]);
  const crates = m.filter((x) => Number(x.type) === MARKER.CRATE);
  const activeNear = (rig) => {
    if (!rig) return false;
    return crates.some((c) => distance(c, rig) <= 120);
  };
  return {
    large: { active: activeNear(rigs.large), monument: rigs.large },
    small: { active: activeNear(rigs.small), monument: rigs.small }
  };
}

async function getTime(rust) {
  const r = await requestAsync(rust, { getTime: {} });
  if (!r?.time) throw new Error('Rust+ nie zwrócił czasu.');
  return `:eyes: Czas w grze: ${formatGameTime(r.time.time)}`;
}
async function getCargo(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CARGO) ? ':exclamation: Cargo Ship: AKTYWNE' : ':exclamation: Cargo Ship: brak'; }
async function getHeli(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.PATROL_HELI) ? ':exclamation: Patrol Helicopter: AKTYWNY' : ':exclamation: Patrol Helicopter: brak'; }
async function getChinook(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CH47) ? ':exclamation: CH47/Chinook: AKTYWNY' : ':exclamation: CH47/Chinook: brak'; }
async function getCrate(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CRATE) ? ':exclamation: Locked Crate: AKTYWNA' : ':exclamation: Locked Crate: brak'; }
async function getSmall(rust) { const s = await getOilRigState(rust); return s.small.active ? ':exclamation: Small Oil Rig: AKTYWNY (Locked Crate na rigu)' : ':exclamation: Small Oil Rig: brak aktywnego crate'; }
async function getLarge(rust) { const s = await getOilRigState(rust); return s.large.active ? ':exclamation: Large Oil Rig: AKTYWNY (Locked Crate na rigu)' : ':exclamation: Large Oil Rig: brak aktywnego crate'; }
async function getEvents(rust) {
  const m = await getMarkers(rust), s = (t) => hasType(m, t) ? '✅' : '❌';
  const oils = await getOilRigState(rust, m);
  return `:exclamation: Cargo ${hasType(m, MARKER.CARGO) ? 'AKTYWNE' : 'brak'} | Heli ${hasType(m, MARKER.PATROL_HELI) ? 'AKTYWNY' : 'brak'} | CH47 ${hasType(m, MARKER.CH47) ? 'AKTYWNY' : 'brak'} | Crate ${hasType(m, MARKER.CRATE) ? 'AKTYWNA' : 'brak'} | Small ${oils.small.active ? 'AKTYWNY' : 'brak'} | Large ${oils.large.active ? 'AKTYWNY' : 'brak'}`;
}
async function getTeam(rust, onlineOnly = false) {
  let r;
  try { r = await requestAsync(rust, { getTeamInfo: {} }); }
  catch (err) { if (String(err?.error || err?.message || err).toLowerCase().includes('not_found')) return '👥 Team info niedostępne na tym serwerze.'; throw err; }
  const members = r?.teamInfo?.members || [];
  const filtered = onlineOnly ? members.filter((m) => m.isOnline) : members;
  if (!filtered.length) return onlineOnly ? '👥 Nikt z teamu nie jest teraz online.' : '👥 Brak danych teamu.';
  const names = filtered.map((m) => `${m.isOnline ? '🟢' : '⚫'}${m.isAlive ? '' : '💀'} ${m.name}`).join(', ');
  return `${onlineOnly ? '🟢 Online' : '👥 Team'} (${filtered.length}${onlineOnly ? `/${members.length}` : ''}): ${names}`.slice(0, 490);
}
async function getStatus(rust) {
  const [time, markers] = await Promise.all([
    requestAsync(rust, { getTime: {} }), requestAsync(rust, { getMapMarkers: {} })
  ]);
  const m = markers?.mapMarkers?.markers || [];
  const oils = await getOilRigState(rust, m);
  let teamText = '👥 n/d';
  try {
    const team = await requestAsync(rust, { getTeamInfo: {} });
    const members = team?.teamInfo?.members || [];
    teamText = `👥 ${members.filter((x) => x.isOnline).length}/${members.length}`;
  } catch (_) {}
  return `🕒 ${formatGameTime(time?.time?.time)} | 🚢 ${hasType(m, MARKER.CARGO) ? '✅' : '❌'} | 🚁 ${hasType(m, MARKER.PATROL_HELI) ? '✅' : '❌'} | 🛢️ S ${oils.small.active ? '✅' : '❌'} L ${oils.large.active ? '✅' : '❌'} | ${teamText}`;
}
async function getServer(rust) {
  const r = await requestAsync(rust, { getInfo: {} });
  const i = r?.info;
  if (!i) return 'ℹ️ Brak danych serwera.';
  const queue = Number(i.queuedPlayers || 0);
  return `🌐 ${i.name || 'Serwer'} | 👥 ${i.players ?? '?'}/${i.maxPlayers ?? '?'}${queue ? ` (+${queue} kolejka)` : ''}`.slice(0, 490);
}

function getDeathsText(deaths = []) {
  if (!deaths?.length) return ':skull: Brak zapisanych śmierci teamu od startu bota.';
  const rows = deaths.slice(-5).reverse().map((d, i) => `${i + 1}. ${d.name || d.steamId} — ${d.grid || `x:${Math.round(d.x)} y:${Math.round(d.y)}`} — ${d.ago || ''}`);
  return `:skull: Ostatnie zgony:\n${rows.join('\n')}`.slice(0, 490);
}

async function handleRustCommand({ rust, command, args, isAuthorized, linkHandler, getDeaths }) {
  if (command === 'link') return linkHandler(args[0]);
  if (!(await isAuthorized())) return '⛔ Brak dostępu. Użyj /link na Discordzie.';
  switch (command) {
    case 'help': return 'Komendy: !time !cargo !heli !chinook !crate !small !large !events !team !online !deaths !status !server';
    case 'time': return getTime(rust);
    case 'cargo': return getCargo(rust);
    case 'heli': return getHeli(rust);
    case 'chinook': return getChinook(rust);
    case 'crate': return getCrate(rust);
    case 'small': return getSmall(rust);
    case 'large': return getLarge(rust);
    case 'events': return getEvents(rust);
    case 'team': return getTeam(rust, false);
    case 'online': return getTeam(rust, true);
    case 'deaths': return getDeathsText(getDeaths ? getDeaths() : []);
    case 'status': return getStatus(rust);
    case 'server': return getServer(rust);
    case 'ping': return '🏓 Pong';
    default: return null;
  }
}

module.exports = { handleRustCommand, MARKER, getOilRigState, getOilRigMonuments };
