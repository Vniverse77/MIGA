# Operating the relay

Runbook for the server that hosts the relay. Files referenced here live in `deploy/`.

## Layout (hardened)

| What | Where | Owner |
|---|---|---|
| relay binary, backup script | `/opt/miga/` | root, read-only for the service |
| web build | `/srv/miga/web` | root, read-only for the service |
| database and blobs | `/var/lib/miga` | `miga` (the only writable path) |
| environment | `/etc/miga/relay.env` | root:miga, 0640 |
| backups | `/var/backups/miga` | root, 0700 |

The service runs as the unprivileged user `miga` (`deploy/miga-relay.service`: `NoNewPrivileges`,
`ProtectSystem=strict`, `ReadWritePaths=/var/lib/miga`, `PrivateTmp`, no capabilities, ...).
`deploy/ecosystem.config.cjs` is the PM2 equivalent if systemd is not wanted.

## Limits

All limits are in-memory counters keyed by IP, pruned automatically, never stored or logged.
Set `MIGA_TRUST_PROXY=1` behind Cloudflare so the real client IP is used.

| Variable | Default | Meaning |
|---|---|---|
| `MIGA_MAX_CONNS_PER_IP` | 20 | simultaneous WebSocket connections per IP (HTTP 429 beyond) |
| `MIGA_CONNS_PER_MIN` | 60 | new WebSocket connections per minute per IP (HTTP 429) |
| `MIGA_MSGS_PER_MIN` | 240 | stored messages and unsends per minute per IP, all connections together (`rate_limited`) |
| `MIGA_NEW_RCPT_PER_HOUR` | 30 | first messages to recipients that have an empty queue and are offline, per IP per hour (`rate_limited`) |
| `MIGA_QUEUE_MSGS` | 1000 | queued messages per recipient (`queue_full`) |
| `MIGA_QUEUE_BYTES` | 8388608 | queued bytes per recipient (`queue_full`) |
| `MIGA_QUEUE_TOTAL_BYTES` | 536870912 | queued bytes in total (`queue_full`) |
| `MIGA_BLOB_QUOTA` | 1073741824 | total blob bytes on disk (HTTP 507) |
| `MIGA_BLOB_UPLOADS_PER_IP` | 2 | concurrent uploads per IP (HTTP 429) |
| `MIGA_BLOB_DOWNLOADS_PER_IP` | 8 | concurrent downloads per IP (HTTP 429) |
| `MIGA_BLOB_UPLOADS_PER_10MIN` | 30 | uploads per 10 minutes per IP (HTTP 429) |

Fixed: 25 MiB per blob, 4 concurrent uploads in total, 32 KiB per frame, 24,000 characters per
message body, 30 messages per 10 s per connection, 30 day expiry.

Queue policy: a full queue rejects the new message (`queue_full`); messages already queued are never
evicted. They leave on acknowledgement, unsend, or after 30 days. Existing clients already handle
`rate_limited`, `queue_full` and failed connections (they retry later).

## Migration from "root under PM2" to the hardened layout

Each step is separate. Do them in order; every step has a check. Total downtime: one restart.

1. Build and stage files (no service impact).
   ```sh
   cd /root/Projects/MIGA && git pull --ff-only && cd relay && CGO_ENABLED=0 go build -o miga-relay
   id miga 2>/dev/null || useradd --system --home-dir /var/lib/miga --shell /usr/sbin/nologin miga
   install -d -o root -g root -m 0755 /opt/miga /srv/miga /srv/miga/web /etc/miga
   install -m 0755 miga-relay /opt/miga/miga-relay
   install -m 0755 ../deploy/backup.sh /opt/miga/backup.sh
   rsync -a /root/Projects/MIGA/web/build/ /srv/miga/web/
   ```
   Check: `ls -l /opt/miga /srv/miga/web | head`; `id miga`.
2. Configuration. Copy `deploy/relay.env.example` to `/etc/miga/relay.env`, replace `MIGA_ORIGINS` with the
   value of the running relay (`pm2 show miga`), then `chown root:miga /etc/miga/relay.env; chmod 0640 /etc/miga/relay.env`.
   From `/root/Projects/MIGA`, install the unit: `install -m 0644 deploy/miga-relay.service /etc/systemd/system/ && systemctl daemon-reload`.
3. Backup first (relay still running under PM2).
   ```sh
   MIGA_DB=/var/lib/miga/miga.db /opt/miga/backup.sh
   ```
   Check: a new directory under `/var/backups/miga` with a `.db.gz` and a `config-*.tar.gz`.
4. Switch (this is the downtime).
   ```sh
   pm2 stop miga && pm2 save
   chown -R miga:miga /var/lib/miga && chmod 0700 /var/lib/miga
   systemctl enable --now miga-relay
   ```
   Check: `systemctl is-active miga-relay`; `curl -s http://127.0.0.1:8787/healthz` prints `ok`;
   `ps -o user= -C miga-relay` prints `miga`; `curl -s https://miga.vniverse77.com/version.json`;
   `scripts/release-deploy.sh` stage `verify` checks (`/app/` 200, `OPTIONS /blob` 204, `/ws` 101).
5. Remove the old PM2 entry once it has run well for a day: `pm2 delete miga && pm2 save`.
6. Use the new layout in releases: `MIGA_LAYOUT=hardened scripts/release-deploy.sh VERSION`
   (installs the binary into `/opt/miga`, syncs the web build to `/srv/miga/web`, `systemctl restart miga-relay`).

Rollback (any time before step 5):
```sh
systemctl disable --now miga-relay
chown -R root:root /var/lib/miga
pm2 start miga && pm2 save
```
The old binary and web build under `/root/Projects/MIGA` are untouched by the migration.

## Backups

`deploy/backup.sh` writes a consistent database copy (`miga-relay backup`, no `sqlite3` needed) and a tarball of the
configuration paths (`/etc/cloudflared /etc/miga` and the unit file by default, overridable with
`MIGA_BACKUP_CONFIG`) into `/var/backups/miga/<timestamp>/` and keeps the newest 7 sets.
The tarball contains the tunnel credentials: keep the directory 0700, never commit it, and copy it off the
machine only encrypted. Blobs are not backed up (they expire after 30 days).

Daily timer:
```sh
install -m 0644 deploy/miga-backup.service deploy/miga-backup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now miga-backup.timer
systemctl list-timers miga-backup.timer
```
Restore: stop the service, `gunzip -c miga-<ts>.db.gz > /var/lib/miga/miga.db`, `chown miga:miga`, remove stale
`miga.db-wal`/`miga.db-shm`, start the service. Config: `tar -xzf config-<ts>.tar.gz -C /`.

## Logs

- systemd: output goes to the journal. Cap it with `deploy/miga-journald.conf`
  (`install -D -m 0644 deploy/miga-journald.conf /etc/systemd/journald.conf.d/miga.conf && systemctl restart systemd-journald`).
- PM2 (until migration, and for other apps on the same PM2): `deploy/pm2-logrotate.sh` installs `pm2-logrotate`
  (10 MB, 7 files, compressed, daily).

The relay logs no addresses, IPs or message ids.
