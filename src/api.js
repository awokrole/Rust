const express = require('express');

class PairingApi {
  constructor({ config, pairingManager }) {
    this.config = config;
    this.pairing = pairingManager;
    this.app = express();
  }

  start() {
    this.app.use(express.json({ limit: '128kb' }));
    this.app.get('/health', (_, res) => res.json({ ok: true, version: '0.5.0', mode: 'discord-only' }));
    this.app.post('/api/pairing/:code/complete', (req, res) => {
      try {
        const result = this.pairing.completeTicket(String(req.params.code || ''), req.body);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message || 'Pairing failed' });
      }
    });
    this.app.use((_, res) => res.status(404).json({ ok: false, error: 'Not found' }));
    this.server = this.app.listen(this.config.port, '0.0.0.0', () => console.log(`[API] listening on :${this.config.port}`));
    return this.server;
  }

  stop() { try { this.server?.close(); } catch (_) {} }
}

module.exports = { PairingApi };
