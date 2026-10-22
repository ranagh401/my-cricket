# MY CRICKET

A two-player cricket game you play against a friend on the same wifi, in the browser, in 3D. One computer runs a tiny server, both players open a web page: a laptop, a phone or a tablet all work. No internet connection is needed and nothing is installed on the second device.

What is in a match:

- **Build your XI** from 110 real international cricketers (India, Australia, England, Pakistan, New Zealand, South Africa, Sri Lanka, West Indies, Bangladesh, Afghanistan) within a 300-credit budget. Better players cost more, so you trade stars for depth. You need enough bowlers to cover the overs. Your list order is the batting order.
- **Toss**, then two innings with a real scorebook: striker and non-striker rotating the strike, a new batter after every wicket, a bowler chosen for each over with a cap on overs per bowler, fall of wickets, batting and bowling figures.
- **Bowling** with line, length and pace plus a release meter. Fast bowlers have a slower ball; spinners turn the ball after it pitches, or push through an arm ball.
- **Batting** with Defend, Attack or Loft, played to the leg side, straight or the off side, timed against the ball reaching the bat. Left-handers are mirrored. A batter's rating widens the timing window; a bowler's rating tightens their accuracy and makes misses more dangerous.
- **Umpire and DRS.** Close lbw and caught-behind appeals go to the on-field umpire, who gets some wrong. The side that disagrees has 12 seconds to review. Ball tracking (pitching, impact, wickets) or UltraEdge decides on screen. A failed review is lost; umpire's call keeps it. Reviews per innings are a match setting.
- **Presentation** in real-time 3D (Three.js, bundled locally): stadium, floodlights, crowd, animated players, a physically moving ball, TV-style cameras that follow the shot, umpire signals, Hawk-Eye style replays, a broadcast scorebug and ball-by-ball commentary.

## Start a game

1. Install [Node.js](https://nodejs.org) (LTS) on the computer that will host. Only the host needs it.
2. Double-click `start.bat` (or run `node server.js` in a terminal). It prints something like:

   ```
   On this computer:   http://localhost:5055
   Friends on your wifi open one of these:
     http://192.168.1.6:5055    (WiFi)
   ```

3. If Windows shows a firewall prompt for Node.js, click **Allow access** (private networks). Without that, the other device cannot connect.
4. Open the `localhost` link on the host. Your friend opens the wifi link on their device. Use a current Chrome, Edge, Safari or Firefox; the 3D view needs WebGL, which every phone and laptop browser from the last several years has.
5. One player types a name, picks overs, wickets and reviews, and presses **Create match**. The other sees it under *Open matches* and presses **Join**, or types the 4-letter code.
6. Both build an XI (or press **Auto-pick for me**) and lock it in. Toss, play, rematch.

## Controls

| | Touch / mouse | Keyboard |
|---|---|---|
| Pick a bowler | tap a name at the start of each over | |
| Line, length, pace | the three button groups | `←` `↑` `→` line, `A` `S` `D` length, `F` pace |
| Bowl | **Bowl**, then **Release** when the marker is in the green | `Space` twice |
| Shot type | Defend / Attack / Loft | `1` `2` `3` |
| Play a shot | Leg / Straight / Off as the ball arrives | `←` `↑` `→` |
| DRS | **REVIEW** or **Accept** within the window | `R` / `Enter` |
| Scorecard | the Scorecard button under the pitch | |

Leaving mid-match forfeits it. A player who drops off the wifi has one minute to come back. Idle players do not stall the game: an unpicked bowler, an unbowled ball, an uncalled toss and an unlocked XI are all decided automatically after a while.

## If your friend cannot connect

- Both devices must be on the **same wifi network**. Guest networks and some office or hotel wifi block devices from seeing each other ("AP isolation"). A phone hotspot works well: the host connects to the hotspot too, restarts `start.bat`, and uses the address it prints.
- Check the Windows firewall. If you dismissed the prompt, run this once in an administrator PowerShell:

  ```
  netsh advfirewall firewall add rule name="MY CRICKET" dir=in action=allow protocol=TCP localport=5055
  ```

- The server picks the next free port if 5055 is taken, so always use the address it prints.
- Find the host's address yourself with `ipconfig` (the IPv4 address of the Wi-Fi adapter).
- Use `http://`, not `https://`.

## Settings

Environment variables read by `server.js`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5055` | Port to listen on (falls through to the next free one if taken) |
| `CRICKET_TIME_SCALE` | `1` | Multiplies every delay: `0.7` makes a faster game, `0.05` is what the tests use |
| `CRICKET_GRACE_MS` | `60000` | How long a disconnected player keeps their seat |

## Files

| File | What it is |
|---|---|
| `server.js` | HTTP + WebSocket server (RFC 6455 implemented in-file, no npm packages), rooms, timers, reconnection |
| `engine.js` | The match engine: squads and budget, toss, bowler rotation, deliveries, shot outcomes, umpire decisions, DRS, scorebook, results. Pure logic with an injectable random generator |
| `public/players.js` | The player database. Real names used without licence for a personal, non-commercial game; ratings are the author's opinion |
| `public/index.html`, `style.css` | The pages: lobby, XI builder, match, phone-first |
| `public/app.js` | Lobby, team builder, scorebug, controls, DRS panel, overlays and the WebSocket link |
| `public/render.js` | The 3D presentation in use (a copy of `render-b.js`, the floodlit night-match look), an ES module on top of `public/vendor/three.module.js` |
| `public/render-a.js`, `render-b.js` | Two complete renderers with the same API: A is a daytime TV-broadcast look, B a vivid floodlit T20 look. To switch, copy the one you prefer over `render.js` |
| `public/preview-a.html`, `preview-b.html` | Visual harnesses for each renderer: every scene on a button, plus `?scene=NAME&t=MS` for deterministic screenshots |
| `test/engine.test.js` | Engine unit tests, including a 120-match fuzz that checks every scorecard invariant |
| `test/e2e.test.js` | Real server + real WebSocket clients: full match with DRS, rematch, forfeit, reconnection, validation |
| `test/browser-check.js` | Plays a full match in headless Chrome or Edge through the real page and saves screenshots |
| `test/smoke.js` | Prints a seeded match ball by ball with the scorecard |
| `start.bat` | Double-click launcher for Windows |

## Tests

```
npm test                  # engine + end-to-end (Node 22 or newer, for the built-in WebSocket client)
npm run check:browser     # needs Chrome or Edge installed; writes screenshots/ next to this file
node test/smoke.js 42 5 5 # seed, overs, wickets: a sample match printed to the console
```

## Why not the real Cricket 07?

EA Sports Cricket 07 is a copyrighted game with local-only multiplayer and no LAN mode, so it cannot be downloaded or patched legally. MY CRICKET is an original game built from scratch for the same purpose: two friends, one wifi, a proper match. Its 3D presentation is stylised, not a recreation of EA's motion-captured production.
