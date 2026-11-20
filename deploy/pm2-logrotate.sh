#!/usr/bin/env bash
# One-time PM2 log rotation setup (for the PM2 that runs the relay and the website).
# Run as the user that owns that PM2 (currently root).
set -euo pipefail
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 save
