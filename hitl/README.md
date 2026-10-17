# HITL: Brainstem (Python) + Hands (RP2040)

An educational hardware-in-the-loop rig. A Python **Brainstem** watches the screen,
runs reflexes and takes orders from an external LLM **Cortex**. A Raspberry Pi Pico
(**Hands**) turns serial bytes into USB HID key presses.

```
 OBS Virtual Cam ─┐                    ┌─ POST /cmd, /batch ─┐
 or dxcam (DXGI) ─┤                    │   WS /ws            │  Cortex (LLM agent)
                  ▼                    ▼                     │
        [capture thread] ──LatestFrame──▶ [vision / main] ───┐
                                          [api: uvicorn] ────┤ SimpleQueue
                                                             ▼
                                  [serial-tx: coalesced write + keepalive] ══USB CDC══▶ Pico
                                  [serial-rx: PONG / NAK]  ◀══════════════════════════  │
                                                                                   USB HID
```

| Path | What |
|---|---|
| `firmware/hands/hands.ino` | Pico firmware: non-blocking `millis()` state machine |
| `firmware/test/` | g++ host test of the firmware with mocked `Keyboard`/`Serial` |
| `brainstem/brainstem.py` | capture, vision, serial link, FastAPI server |
| `tests/test_brainstem.py` | Python tests (no hardware needed) |

## Firmware

Arduino IDE → board **earlephilhower/arduino-pico**, *Raspberry Pi Pico*, Tools → USB Stack:
**Pico SDK** (CDC + HID composite). Flash `firmware/hands/hands.ino`.

### Wire protocol (host → Pico)

| Bytes | Meaning |
|---|---|
| `0x20..0x7E` | legacy one-byte TAP (`'H'`, `'W'` …), 50 ms by default, per-command overrides in `kBinds` |
| `0x01 k` | PRESS `k`: held until RELEASE, auto-released after 5 s unless re-sent |
| `0x02 k` | RELEASE `k` |
| `0x03 k lo hi` | TAP `k` for `hi<<8 \| lo` ms |
| `0x04` | RELEASE ALL |
| `0x05` | PING → Pico answers `0x06` |

`k` is an Arduino `Keyboard.h` value: ASCII or `KEY_*` (`0x81` = Left Shift, `0xC2` = F1 …).
The Pico answers `0x15` (NAK) when all 6 key slots are taken.

Your old scripts that send single letters still work. One change: `'W'` now presses
`w`. Before, `Keyboard.press('W')` sent **Shift+W**, because the Arduino ASCII map
adds Shift for uppercase letters. In most games that's sprint+forward, not forward.

Safety: all keys come up when the host closes the port (DTR drops, i.e. the script
exited or crashed). Held keys also come up when the 5 s dead-man timer runs out
(the script hung but the port stayed open). `SerialLink` re-sends PRESS for held
keys every second, so a long hold works.

```bash
cd firmware/test && g++ -std=c++17 -Wall -Imocks host_test.cpp -o host_test && ./host_test
```

## Brainstem

Requires Python 3.10+.

```bash
pip install -r brainstem/requirements.txt
# OBS Virtual Camera (index 1), health bar at x=40,y=1000, 300x12 px
python brainstem/brainstem.py --serial COM5 --source obs --camera 1 --heal-roi 40,1000,300,12
# Grab the desktop directly (Windows), only the top-left 1280x720
python brainstem/brainstem.py --serial COM5 --source dxcam --region 0,0,1280,720 --fps 144
```

Cortex API (default `127.0.0.1:8765`, OpenAPI docs at `/docs`):

```bash
curl -X POST localhost:8765/cmd -H 'content-type: application/json' -d '{"key":"w","action":"press"}'
curl -X POST localhost:8765/cmd -d '{"key":"w","action":"release"}' -H 'content-type: application/json'
curl -X POST localhost:8765/cmd -d '{"key":"e","ms":120}' -H 'content-type: application/json'
curl -X POST localhost:8765/batch -d '[{"key":"shift","action":"press"},{"key":"w","ms":400}]' -H 'content-type: application/json'
curl -X POST localhost:8765/reflexes -d '{"enabled":false}' -H 'content-type: application/json'   # Cortex takes over
curl localhost:8765/status     # capture fps, skipped frames, vision latency, serial counters
curl localhost:8765/ping       # USB round trip to the Pico
```

A Cortex that sends a stream of commands should use **`ws://…/ws`** (one JSON
command or list per message, silent on success). That skips the HTTP request and
response framing on every command.

```bash
python -m pytest tests -s
```

## Where the latency went

### 1. Pico: `delay(50)` → state machine

Before, `press → delay(50) → release` froze `loop()` for 50 ms per command. `'H'`
followed by `'W'` meant W went down 50 ms late, and N queued commands meant
N × 50 ms. Keys could never be down at the same time.

Now every pass of `loop()` drains up to 64 RX bytes, expires slots by deadline,
and returns. A pass takes microseconds, so a command is applied the same
millisecond it arrives. Up to 6 keys are down at once, each with its own
duration. Re-sending a key that's already down only extends its deadline.

From the Pico's side, the rest is USB timing. A CDC OUT transfer lands within one
1 ms full-speed frame. The HID report goes out on the next IN poll, so the
endpoint's `bInterval` sets the floor (1 ms at best). Check it with USBTreeView or
`lsusb -v` for your core version. The firmware isn't the limit any more.

### 2. Vision: blocking `cap.read()` → producer/consumer mailbox

Before, the main loop alternated *wait for camera → process → send*. While it was
processing, the driver queued the next frame. So the loop ran on frames that were
already one or more periods old, and processing time added directly to capture
time.

Now:
- A capture thread blocks in `cap.read()` / `get_latest_frame()`. Both release the
  GIL, so this costs the other threads nothing. It overwrites a single-slot
  `LatestFrame` mailbox.
- The vision loop blocks on a `Condition` until a frame **newer than the last one
  it processed** exists. It never processes the same frame twice, never processes
  a stale one, and doesn't spin. `/status` shows skipped frames, so you can see
  when vision is slower than capture.
- `CAP_PROP_BUFFERSIZE=1` and the DirectShow backend keep the driver from queueing.
  Reflexes read only their ROI, never the whole frame.

**dxcam vs. OBS Virtual Camera.** dxcam uses DXGI Desktop Duplication and skips
the whole chain: OBS compositing → virtual camera → DirectShow → colour
conversion. That chain typically adds 1–3 frames. dxcam isn't truly zero-copy:
there's one GPU→CPU copy into a numpy buffer, but no encode, decode or extra
hop. For a reflex loop it's the biggest single win in this system. Run it with
`--fps` at or above your monitor's refresh rate. Keep OBS when the source isn't
your own screen (a capture card, another PC).

### 3. API: Flask → FastAPI on uvicorn

- uvicorn runs on its own thread with its own asyncio event loop (uvloop +
  httptools via `uvicorn[standard]` on Linux, httptools on Windows).
- Handlers are `async def` and only do a `SimpleQueue.put()`. They run inline
  on the event loop and never block, so they don't use the threadpool (`def`
  handlers would) or touch the serial port.
- In-process on purpose. A separate process would add an IPC hop. Only one
  process can hold a COM port on Windows, so the API would have to forward to
  the vision process anyway. The GIL isn't a problem here: capture, numpy and
  cv2 release it.
- `access_log=False`. Per-request log formatting costs more than the handler.

### 4. Serial: one writer, coalesced

Vision and the API both call `SerialLink.send()`, a non-blocking enqueue. The TX
thread wakes up, drains **everything** pending into one `write()`, and goes back
to sleep. A burst becomes one syscall and usually one USB packet. Neither caller
ever waits on the port. If the port drops, the TX thread reconnects every second
and throws away commands meant for it in the meantime. A stale reflex is worse
than none.

### Measured (this repo's benchmark, Linux cloud VM, fake serial port)

| Path | p50 | p99 |
|---|---|---|
| Flask dev server, POST /cmd (new connection) | 1354 µs | 3112 µs |
| FastAPI, asyncio + h11, new connection | 1150 µs | 2009 µs |
| FastAPI, uvloop + httptools, new connection | 707 µs | 1352 µs |
| FastAPI, uvloop + httptools, **keep-alive** | 324 µs | 889 µs |
| **WebSocket** message → bytes handed to serial `write()` | 191 µs | 460 µs |
| Vision `link.send()` → serial `write()` (thread hand-off) | 94 µs | 181 µs |

A desktop CPU will be faster than this VM. Main lessons: keep the HTTP connection
alive (`requests.Session` / `httpx.Client`), or better, use the WebSocket.

### The honest end-to-end budget

The software path, from command or frame in to `write()` on the port, is now well
under a millisecond. The end-to-end path from photon to key event can't be,
whatever the code does:

| Stage | Typical |
|---|---|
| Display/capture frame period (60 / 144 Hz) | 16.7 / 6.9 ms (avg. half of that waiting for the next frame) |
| OBS virtual-cam pipeline (skipped with dxcam) | +1–3 frames |
| Reflex on an ROI | 0.05–1 ms |
| Brainstem → serial write | ≈0.1 ms |
| USB CDC OUT (host → Pico) | ≤1 ms |
| Pico parse + HID report queued | µs |
| USB HID IN poll | ≤`bInterval` (1 ms best case) |
| OS input stack + game reading input on its next tick | game-dependent, often the largest term |

To go faster from here: use dxcam at high fps, a higher-refresh display, small
ROIs, and the WebSocket for the Cortex.

---

Use this on single-player/offline games or your own software. Hardware-HID input
automation in online games breaks most ToS and anti-cheat rules.
