# Deep-capture playbook — two parallel data streams

## Stream 1 — WEB traffic (architecture / data-layer) via capture.mjs on matiks.com
Native-app traffic isn't capturable without invasive MITM (Android ignores user CAs + possible pinning). The web app hits the **same GraphQL + WS backend**, so do the rich browsing here.

**Setup**
1. Relaunch the debug Chrome:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/matiks-capture-profile"`
2. Log into matiks.com (test account).
3. `cd ~/Documents/math-game/matiks-capture && npm run capture`
4. Do the tour below. `Ctrl+C` when done → send me the new `captures/*.jsonl`.

**The tour — hit as many distinct flows as possible (each = new ops):**
- [ ] Home (full load)
- [ ] BLITZ/DMAS duel (full)
- [ ] PUZZLE / Math-Maze duel
- [ ] MEMORY duel (if available)
- [ ] 2nd BLITZ duel (repeat → reveals static vs per-game data)
- [ ] Enter/view a LEAGUE (+ previous week if shown)
- [ ] CONTESTS → open one → REGISTER / start an attempt
- [ ] Stake coins on a duel if `betInfo` is offered (captures the economy flow)
- [ ] CHAT / buddy thread (GROUP_CHAT WS)
- [ ] Leaderboard (global + friends)
- [ ] Daily challenge + daily puzzle
- [ ] Profile / stats / achievements; Settings
- [ ] (bonus) 1 duel on wifi + 1 on mobile data (or throttled) → latency comparison

## Stream 2 — PHONE native perf (engine / jank) — no traffic capture needed
1. Reconnect phone (USB + allow debugging) → tell me; I pull + dissect the **APK**.
2. **Perfetto** trace during one Blitz duel (System Tracing tile; stop right after Q1) → `adb pull` → send. (Settles the decrypt-timing test.)
3. (bonus) `gfxinfo` reset→play→dump for **Blitz vs Puzzle** to compare jank by mode.

## What the extra data unlocks
- Latency / jitter / answer-RTT become statistically robust (many duels, not n=1).
- Contest + league + economy (`betInfo`) + chat + async-mode flows — currently unmapped.
- More reconciliation scenarios to validate the prediction engine.
- Per-category perf differences (Blitz vs Puzzle vs Memory).
