const MARKER = { CH47: 4, CARGO: 5, CRATE: 6, PATROL_HELI: 8 };

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

async function getTime(rust) {
  const r = await requestAsync(rust, { getTime: {} });
  if (!r?.time) throw new Error('Rust+ nie zwrócił czasu.');
  return `🕒 Czas w grze: ${formatGameTime(r.time.time)}`;
}
async function getCargo(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CARGO) ? '🚢 Cargo Ship: AKTYWNE' : '🚢 Cargo Ship: brak'; }
async function getHeli(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.PATROL_HELI) ? '🚁 Patrol Helicopter: AKTYWNY' : '🚁 Patrol Helicopter: brak'; }
async function getChinook(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CH47) ? '🚁 CH47/Chinook: AKTYWNY' : '🚁 CH47/Chinook: brak'; }
async function getCrate(rust) { const m = await getMarkers(rust); return hasType(m, MARKER.CRATE) ? '📦 Locked Crate: AKTYWNA' : '📦 Locked Crate: brak'; }
async function getEvents(rust) {
  const m = await getMarkers(rust), s = (t) => hasType(m, t) ? '✅' : '❌';
  return `🚢 Cargo ${s(MARKER.CARGO)} | 🚁 Heli ${s(MARKER.PATROL_HELI)} | 🚁 CH47 ${s(MARKER.CH47)} | 📦 Crate ${s(MARKER.CRATE)}`;
}
async function getTeam(rust, onlineOnly = false) {
  const r = await requestAsync(rust, { getTeamInfo: {} });
  const members = r?.teamInfo?.members || [];
  const filtered = onlineOnly ? members.filter((m) => m.isOnline) : members;
  if (!filtered.length) return onlineOnly ? '👥 Nikt z teamu nie jest teraz online.' : '👥 Brak danych teamu.';
  const names = filtered.map((m) => `${m.isOnline ? '🟢' : '⚫'}${m.isAlive ? '' : '💀'} ${m.name}`).join(', ');
  return `${onlineOnly ? '🟢 Online' : '👥 Team'} (${filtered.length}${onlineOnly ? `/${members.length}` : ''}): ${names}`.slice(0, 490);
}
async function getStatus(rust) {
  const [time, markers, team] = await Promise.all([
    requestAsync(rust, { getTime: {} }), requestAsync(rust, { getMapMarkers: {} }), requestAsync(rust, { getTeamInfo: {} })
  ]);
  const m = markers?.mapMarkers?.markers || [];
  const online = (team?.teamInfo?.members || []).filter((x) => x.isOnline).length;
  const total = (team?.teamInfo?.members || []).length;
  return `🕒 ${formatGameTime(time?.time?.time)} | 🚢 ${hasType(m, MARKER.CARGO) ? '✅' : '❌'} | 🚁 ${hasType(m, MARKER.PATROL_HELI) ? '✅' : '❌'} | 📦 ${hasType(m, MARKER.CRATE) ? '✅' : '❌'} | 👥 ${online}/${total}`;
}
async function getServer(rust) {
  const r = await requestAsync(rust, { getInfo: {} });
  const i = r?.info;
  if (!i) return 'ℹ️ Brak danych serwera.';
  const queue = Number(i.queuedPlayers || 0);
  return `🌐 ${i.name || 'Serwer'} | 👥 ${i.players ?? '?'}/${i.maxPlayers ?? '?'}${queue ? ` (+${queue} kolejka)` : ''}`.slice(0, 490);
}

async function handleRustCommand({ rust, command, args, isAuthorized, linkHandler }) {
  if (command === 'link') return linkHandler(args[0]);
  if (!(await isAuthorized())) return '⛔ Brak dostępu. Użyj /link na Discordzie.';
  switch (command) {
    case 'help': return 'Komendy: !time !cargo !heli !chinook !crate !events !team !online !status !server';
    case 'time': return getTime(rust);
    case 'cargo': return getCargo(rust);
    case 'heli': return getHeli(rust);
    case 'chinook': return getChinook(rust);
    case 'crate': return getCrate(rust);
    case 'events': return getEvents(rust);
    case 'team': return getTeam(rust, false);
    case 'online': return getTeam(rust, true);
    case 'status': return getStatus(rust);
    case 'server': return getServer(rust);
    case 'ping': return '🏓 Pong';
    default: return null;
  }
}

module.exports = { handleRustCommand, MARKER };
