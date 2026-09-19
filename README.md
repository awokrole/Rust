# Rust Helper v0.3

Bot Discord + Rust+ dla wielu serwerów i wielu teamów.

## Najważniejsze funkcje

- wiele kont Rust+ jednocześnie,
- automatyczne wykrywanie teamów,
- jeden `ACTIVE` sender na team i dowolna liczba `BACKUP`,
- sticky failover: konto które przejęło ACTIVE pozostaje nim aż wypadnie,
- team chat przez Rust+ bez pluginu na serwerze,
- autoryzacja Steam ↔ Discord + wymagana rola,
- panel WWW z Discord OAuth,
- szyfrowanie playerToken przy ustawionym `ENCRYPTION_KEY`,
- automatyczne alerty Cargo / Heli / CH47 / Locked Crate,
- opcjonalne kopiowanie alertów na kanał Discord.

## Komendy w Rust team chat

- `!help` – lista komend
- `!link 123456` – łączy Steam z Discordem
- `!time` – czas w grze
- `!cargo` – Cargo Ship
- `!heli` – Patrol Helicopter
- `!chinook` – CH47
- `!crate` – Locked Crate
- `!events` – wszystkie śledzone eventy
- `!team` – cały team
- `!online` – członkowie online
- `!status` – szybkie podsumowanie
- `!server` – populacja i nazwa serwera
- `!ping` – test działania

## Discord

- `/link`
- `/unlink`
- `/mysteam`
- `/rustaccount-add`
- `/rustaccount-remove`
- `/rustaccount-list`

## Start lokalny

```powershell
npm install
npm run check
npm start
```

Skopiuj `.env.example` do `.env` i uzupełnij zmienne.

## Railway

Ustaw `DATA_DIR=/data` i podepnij persistent volume do `/data`. Sekrety Discord/Rust+ trzymaj w Railway Variables. Bot powinien działać jako stały service, nie jako proces zasypiający.

## Pairing Rust+

W v0.3 istniejące dane pairingu można dodać przez Discord albo panel WWW. Następny moduł projektu to pełny webowy pairing Rust+ bez instalowania Node/PowerShell po stronie użytkownika.
