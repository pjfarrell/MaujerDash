#!/bin/sh
# Redeploys the Pi when the remote has moved: fetch, and if anything came
# down, stop the stack, drop the image, pull main and bring it back up.
#
# Safe to run on a timer, e.g. every five minutes from cron:
#   */5 * * * * /home/kohei/MaujerDash/scripts/update.sh >> /home/kohei/maujerdash-update.log 2>&1

set -eu

APP_DIR=/home/kohei/MaujerDash
cd "$APP_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# git fetch prints nothing when there is nothing new (its progress goes to
# stderr, so capture both).
fetched=$(git fetch 2>&1)
if [ -z "$fetched" ]; then
  exit 0
fi
log "fetch returned changes:"
echo "$fetched"

# stats always prints a header row, so the stack is running only if there is
# at least one line after it.
if docker compose stats --no-stream 2>/dev/null | tail -n +2 | grep -q .; then
  log "stopping the running stack"
  docker compose down
  docker image rm -f maujerdash
fi

log "pulling main"
git pull origin main

# --build so the image is rebuilt from the pulled code even when the stack was
# not running and the old image was left in place.
log "starting the stack"
docker compose up -d --build
log "done"
