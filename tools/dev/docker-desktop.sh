# Docker Desktop on WSL, shared by up.sh and demo.sh (source it, do not run it).
# While Docker Desktop is stopped, /usr/bin/docker is a broken link into /mnt/wsl/docker-desktop
# and the docker found on PATH is the Windows one, which cannot start it. docker.exe can.

# True if this is WSL with Docker Desktop integration on but Docker Desktop stopped.
docker_desktop_stopped() {
  [ -L /usr/bin/docker ] && [ ! -e /usr/bin/docker ] && command -v docker.exe >/dev/null
}

# Starts Docker Desktop and waits up to 3 minutes until docker answers inside WSL.
start_docker_desktop() {
  docker.exe desktop start >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    [ -e /usr/bin/docker ] && /usr/bin/docker info >/dev/null 2>&1 && break
    sleep 3
  done
  hash -r
}
