# Open OnDemand integration

This project doesn't ship an [Open OnDemand](https://openondemand.org/)
Interactive App bundle - this page is guidance for wiring `cnt-vnc-viewer`
into one.

## Reverse-proxy compatibility

OOD's Interactive Apps reverse-proxy a web app running on a compute node
under a per-session URL such as
`https://ondemand.example.edu/rnode/<host>/<port>/`. `cnt-vnc-viewer`
resolves all of its own page assets and connections relative to that URL,
so it can be proxied as-is with no rewrite rules.

## Typical launch script shape

Illustrative, not a literal file from this repo - an OOD Interactive App's
launch script would do something like:

```bash
# 1. Generate a random per-session VNC password and start the VNC server with it
VNC_PASSWORD=$(openssl rand -base64 12)
PASSWD_FILE=$(mktemp)
vncpasswd -f <<< "${VNC_PASSWORD}" > "${PASSWD_FILE}"
vncserver :$DISPLAY_NUM -geometry 1280x720 -deferupdate 40 -rfbauth "${PASSWD_FILE}" ...
VNC_PORT=$((5900 + DISPLAY_NUM))

# 2. Pick a free HTTP port for cnt-vnc-viewer
PORT=$(find_free_port)

# 3. Start cnt-vnc-viewer bound to localhost, pointed at that VNC server
./cnt-vnc-viewer \
    -listen-http "127.0.0.1:${PORT}" \
    -vnc-addr "127.0.0.1:${VNC_PORT}" \
    -native-geometry "1280x720" \
    -pulse-spawn &

# 4. Tell OOD which host/port to proxy to
set_host "$(hostname)"
set_port "${PORT}"
```

The link OOD gives the user would then include the client URL params:
`?autoconnect=true&password=<VNC_PASSWORD>`.

## Why pass the VNC password in the URL, if OOD already gates access?

OOD's own login already restricts a user to their own session's URL, so
the password is an extra layer, not the only one: without it, the page
loads but the VNC server itself refuses the connection - using its own
standard VncAuth challenge, not anything specific to this app. That's
useful if a session URL is ever shared, logged, or leaks outside the
authenticated proxy path.

## TLS

OOD's reverse proxy normally terminates TLS between the browser and
itself, and the hop from there to the compute node stays on the cluster's
internal network - so `cnt-vnc-viewer` listening on plain HTTP at
`127.0.0.1:<port>` (the default) is the expected setup. If a site needs
that internal hop encrypted too, `-listen-https` / `-tls-cert` /
`-tls-key` (or `-auto-tls`) are available - see `configuration.md`.

## Audio

Compute nodes are ephemeral batch allocations with no audio service of
their own running by default, so `-pulse-spawn` (run an isolated audio
daemon scoped to the job) is the relevant mode here, rather than pointing
at an existing one.

## Session cleanup

The server shuts down cleanly on `SIGINT`/`SIGTERM`, which lines up with
how OOD/the scheduler ends a session - killing the job when it's cancelled
or times out.

## Resolution and bandwidth

This project defaults to a 720p desktop and a tuned server update rate.
Both matter more, not less, in an OOD context, since the path from the
compute node to the browser is often a shared or metered campus network
rather than localhost. A workload that's mostly video is a particularly
bad fit for VNC in general - expect noticeably higher bandwidth for
video-heavy sessions than for a typical desktop/IDE workload.
