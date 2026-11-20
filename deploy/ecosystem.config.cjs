// PM2 alternative to the systemd unit (runs under the "miga" user's own PM2, not root's).
// Start: sudo -u miga pm2 start /opt/miga/ecosystem.config.cjs && sudo -u miga pm2 save
module.exports = {
  apps: [{
    name: 'miga',
    script: '/opt/miga/miga-relay',
    cwd: '/var/lib/miga',
    env: {
      MIGA_ADDR: '127.0.0.1:8787',
      MIGA_DB: '/var/lib/miga/miga.db',
      MIGA_BLOBS: '/var/lib/miga/blobs',
      MIGA_STATIC: '/srv/miga/web',
      MIGA_ORIGINS: 'tauri://localhost,http://tauri.localhost',
      MIGA_TRUST_PROXY: '1',
    },
    max_restarts: 20,
    max_size: '10M',
  }],
};
