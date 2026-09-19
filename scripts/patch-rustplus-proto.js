const fs = require('fs');
const path = require('path');

const proto = path.join(__dirname, '..', 'node_modules', '@liamcottle', 'rustplus.js', 'rustplus.proto');
if (!fs.existsSync(proto)) {
  console.error('[patch] rustplus.proto not found:', proto);
  process.exit(1);
}
let text = fs.readFileSync(proto, 'utf8');
const replacements = [
  ['required uint32 queuedPlayers = 9;', 'optional uint32 queuedPlayers = 9;'],
  ['required bool isOnline = 5;', 'optional bool isOnline = 5;'],
  ['required uint32 spawnTime = 6;', 'optional uint32 spawnTime = 6;'],
  ['required bool isAlive = 7;', 'optional bool isAlive = 7;'],
  ['required uint32 deathTime = 8;', 'optional uint32 deathTime = 8;'],
  ['required int32 type = 2;', 'optional int32 type = 2;']
];
let changed = 0;
for (const [from, to] of replacements) {
  if (text.includes(from)) {
    text = text.split(from).join(to);
    changed++;
  }
}
fs.writeFileSync(proto, text, 'utf8');
console.log(`[patch] rustplus.proto patched (${changed} rule(s) applied)`);
