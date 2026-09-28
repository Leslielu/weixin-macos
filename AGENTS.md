# AGENTS.md

This file provides repository-specific guidance for coding agents working on
weixin-macos. It is derived from `CLAUDE.md`; when project behavior is
unclear, inspect the current implementation before relying on older examples
in either document.

**This file is maintained by the repository owner.** Do not modify or
regenerate it. If it carries uncommitted changes, commit them as-is.

## Project Overview

WeChat for macOS reverse engineering. The project hooks WeChat's underlying
message sending capability (based on Tencent's open-source `mars` library
protobuf path) via Frida, and exposes an OneBot protocol HTTP/WebSocket API
for programmatic message sending and receiving.

- Fork of `yincongcyincong/wechat_chatter` (remote `upstream`). File issues
  against the upstream repository, not the fork; upstream update checks and
  merges are also based on the upstream remote.
- Production runs on the remote host `mac-m1` (gadget mode, no SIP changes)
  under `~/Prog/wxgate/`, supervised by an auto-restart watchdog that performs
  full crash recovery without human interaction.
- Supported protocol surface: text plus five media classes (image, video,
  voice, file, reply/quote); receives messages via HTTP callback and
  WebSocket.

## Environment

- Local development machine: macOS Sequoia, Apple Silicon.
- Production host: `mac-m1` (macOS Tahoe), WeChat 4.1.13.63 as a re-signed
  adhoc copy, UGREEN dummy display 1920x1080 as the main screen.
- frida-core-devkit 17.8.1 lives in `frida-devkit/` (gitignored, local
  build dependency only). Original archive:
  `~/frida-dev/frida-core-devkit-17.8.1-macos-arm64.tar.xz`.
- Code signing material is in `~/.wxsign/` (`wxsign.p12` + pass file,
  CN=wxgate-signer, expires 2036, shared by wxgate and onebot). The signing
  identity must never change: macOS TCC grants are recorded per identity, and
  re-signing under a different identity re-triggers authorization prompts
  that can deadlock the headless host.
- OCR support (watchdog) uses the RapidOCR environment at
  `~/Prog/mumble/.venv/bin/python` on mac-m1; models are bundled and offline.

## Repository Map

- `frida/`: Frida hook scripts. `script.js` is the full-featured hook
  (send + receive); `succ.js` is the send-only main; per-media scripts
  (`video.js`, `upload_image.js`, `receiver.js`, ...) are analysis helpers.
- `onebot/`: Go service implementing the OneBot protocol. HTTP server on
  127.0.0.1:58080; message callback to wxgate on 127.0.0.1:36060; WebSocket
  via `-conn_type=websocket`; gadget mode via `-type=gadget
  -gadget_addr=127.0.0.1:27042`.
- `watchdog/`: authoritative copy of the auto-restart watchdog
  (`wechat-watchdog.sh` + `ocr_allow.py` + `ocr_selftest.sh`). The deployed
  copy lives at `~/Prog/wxgate/` on mac-m1; keep both in sync.
- `wechat_version/`: per-WeChat-version memory offset JSONs. `*.partial.json`
  files are in-progress adaptations; attaching with an incomplete key set
  ("blind hooking") crashes WeChat.
- `tools/addrfind`: cross-version address finder (structVer switch).
  Methodology and workflow: `docs/version-upgrade.md`.
- `idapro/`, `diaphora/`: static analysis scripts and notes.
- `docs/`: operational documentation. Read `docs/crash-history.md` before any
  crash investigation; it records fingerprints, root causes, shipped fixes,
  and known open issues.
- `test-assets/`: fixed regression media (image, 5s video, 10s voice, text
  file). Recipes and md5s live in the test skill; re-sending the fixed video
  doubles as a CDN dedup-refill regression.
- `frida-gadget/`: no-SIP alternative injection approach and instructions.
- `version_bin/`, `hook/`: auxiliary version artifacts and extra hooks.

## Build and Deploy (onebot)

Build locally with the bundled devkit, then re-sign — every `go build`
produces a fresh unsigned binary and must be re-signed with the fixed
certificate (temporary-keychain recipe, no GUI prompts; full script in
`CLAUDE.md`). Deployment is rsync of the signed binary to
`~/Prog/weixin-macos/onebot/onebot` on mac-m1, then a chain restart via
`~/Prog/wxgate/start.sh restart` (stop onebot → wxgate first, then bring the
chain up in order). The remote host needs no build environment.

Mandatory ordering: build → re-sign (`codesign --verify` must pass) →
rsync → restart chain. Never deploy an unsigned or identity-changed binary.

## Watchdog

Responsibilities (one pass every 30s via LaunchAgent, idempotent):

- WeChat death → clean residue processes and update prompts → relaunch →
  log in via synthesized events (TCC "allow" click located by OCR, Return
  key when WeChat is frontmost) → restart the bot chain → send recovery
  alert (text + screenshot) to the alert user.
- External WeChat restart detected by PID change → chain restart follows.
- onebot port 58080 not listening → chain restart.
- Boot window: a grace gate defers action while the system settles; a
  boot-window fallback handles WeChat launched by macOS session restore
  before the gate opens.

Operational rules:

- Before upgrading or manually touching WeChat on mac-m1:
  `touch /tmp/wechat_watchdog.paused`; remove the file to resume.
- `clicclick` synthesized events only work inside the launchd GUI context,
  never over ssh. Test through the `com.user.clicclick_test` LaunchAgent
  (kickstart); its `/tmp` runner script is periodically cleaned away and
  must be rebuilt before use.
- Screenshots land in `~/Prog/wxgate/shots/` (screencapture location);
  they double as forensic evidence for TCC/login issues.
- Watchdog changes are developed in `watchdog/` here, then deployed with
  backup (`.bak.<date>`), `bash -n`, scp-to-/tmp + atomic `mv`, and md5
  verification on both ends (procedure in `CLAUDE.md`).
- Login-state signals are unreliable: a visible `wxid_*` directory does not
  mean WeChat is logged in. Never gate decisions on login state.

## Implementation Rules

Safety-critical invariants learned from production incidents:

- **Never kill onebot while its WeChat is alive.** The gadget session attach
  is one-shot; a detached/onebot-killed chain must go through a full chain
  restart to recover.
- **Hooks only attach, never detach.** Removing an installed hook mid-flight
  crashes WeChat (TLS affinity is known technical debt).
- **Dequeue pump boundaries are fixed.** The persistent pump and its
  gettimeofday-extended scope cured send starvation; do not move the pump
  edge or gate it behind conditions that can go quiet.
- **The `0x33` zone is raw-read only** in media handling paths.
- **Clear the protobuf message body before `OnTaskEnd`** to prevent
  use-after-free crashes in the mars task teardown.
- **Complete address JSONs before attach.** A new WeChat version needs its
  full key set (via `tools/addrfind`, see `docs/version-upgrade.md`);
  hooking with partial addresses crashes WeChat deterministically.
- **Re-sign after every build** (see Build and Deploy).
- Suppress WeChat update prompts at the source (Sparkle
  `SUEnableAutomaticCheck(s)` keys) rather than clicking them away; an
  accidental "Update Now" invalidates every hook address.

## Testing and Verification

- API smoke test against a running onebot:

```bash
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"wxid_xxx","message":[{"type":"text","data":{"text":"hello"}}]}' \
  http://127.0.0.1:58080/send_private_msg
```

- Media regression uses the fixed `test-assets/` files (image, 5s video,
  10s voice, text) across the five media classes; the fixed video resend
  also exercises CDN dedup refill.
- Watchdog changes are validated with a live drill on mac-m1: kill WeChat
  and watch the full recovery timeline in `~/Prog/wxgate/watchdog.log`
  (expected: OCR allow-clicks, zombie-UNC kill on 3 consecutive OCR misses,
  Return-key login, chain restart, alert delivery, ≈3 minutes end to end).

## Git and Safety

- Never run `git reset` without explicit user approval.
- `Agents.md` / `AGENTS.md` are maintained by the repository owner; do not
  edit them. Commit any pending changes to them as-is.
- Issues go to the upstream repository, not the fork.
- Never commit secrets or signing material (`~/.wxsign/`), build
  dependencies (`frida-devkit/`), or compiled binaries.
- Local machine develops and pushes; remote machines only pull and run.
  The remote Mac never executes `git push`.

## Remote Mac Operations

All access goes through the `ssh mac-m1` alias (FRP relay). SSH sessions
lack Homebrew in PATH — use full paths or export it. Key locations on
mac-m1:

- Chain control: `~/Prog/wxgate/start.sh` (start|stop|restart).
- Watchdog: `~/Prog/wxgate/wechat-watchdog.sh`, log `~/Prog/wxgate/watchdog.log`,
  screenshots `~/Prog/wxgate/shots/`, state files under `/tmp/wechat_watchdog.*`.
- Deployed onebot: `~/Prog/weixin-macos/onebot/onebot`.

Before restarting the remote chain or overwriting remote state, confirm the
current production status (WeChat alive, 58080 listening) and pause the
watchdog if WeChat itself will be touched.

## Agent Workflow

1. For crash or send-failure work, read `docs/crash-history.md` first;
   for version upgrades, read `docs/version-upgrade.md` first.
2. Read the relevant implementation and nearby configuration before
   changing code; check `git status` and preserve unrelated worktree
   changes.
3. Implement the smallest coherent change that follows existing patterns.
4. Verify with the narrowest relevant check (focused API test, fixed
   test-assets regression, watchdog drill) before broader checks.
5. Summarize changed files, behavior, verification results, and anything
   that could not be verified locally.

When `CLAUDE.md` and this file differ, treat concrete safety constraints as
additive; for implementation details the current code is authoritative.
