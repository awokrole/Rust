const crypto = require('node:crypto');

function normalizeKey(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 32) return buf;
  } catch (_) {}
  return crypto.createHash('sha256').update(value).digest();
}

class SecretBox {
  constructor(rawKey) { this.key = normalizeKey(rawKey); }
  get enabled() { return Boolean(this.key); }

  #encryptString(value) {
    if (!this.key) return { plaintextText: String(value) };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), data: encrypted.toString('base64') };
  }

  #decryptString(payload) {
    if (payload == null) throw new Error('Brak sekretu.');
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'plaintextText')) return String(payload.plaintextText);
    if (typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'plaintext')) return String(payload.plaintext);
    if (!this.key) throw new Error('Sekret jest zaszyfrowany, ale ENCRYPTION_KEY nie jest ustawiony.');
    if (payload.enc !== 'aes-256-gcm') throw new Error('Nieznany format zaszyfrowanego sekretu.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  }

  encrypt(value) {
    if (!this.key) return { plaintext: Number(value) };
    return this.#encryptString(String(value));
  }

  decrypt(payload) {
    if (payload == null) throw new Error('Brak playerToken.');
    if (typeof payload === 'number') return payload;
    if (typeof payload === 'string' && /^-?\d+$/.test(payload)) return Number(payload);
    if (typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'plaintext')) return Number(payload.plaintext);
    const clear = this.#decryptString(payload);
    if (!/^-?\d+$/.test(clear)) throw new Error('Nieprawidłowy playerToken po odszyfrowaniu.');
    return Number(clear);
  }

  encryptText(value) { return this.#encryptString(value); }
  decryptText(payload) { return this.#decryptString(payload); }
}

module.exports = { SecretBox };
