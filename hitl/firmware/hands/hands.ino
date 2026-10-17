/*
 * hands.ino — "Hands" firmware: RP2040 (Raspberry Pi Pico) as a USB HID keyboard
 * driven over USB CDC serial by the Python "Brainstem".
 *
 * Core: earlephilhower/arduino-pico, Tools → USB Stack: "Pico SDK" (default).
 * That exposes CDC Serial + HID Keyboard as one composite USB device.
 *
 * loop() never blocks: serial bytes go through a byte-at-a-time parser, every
 * held key lives in a slot with its own deadline, and slots are expired by
 * comparing millis() (wrap-safe unsigned subtraction). No delay() anywhere.
 *
 * Wire protocol, host → Pico
 *   0x20..0x7E      legacy one-byte TAP. Looked up in kBinds, otherwise an
 *                   uppercase letter maps to its lowercase key (no implicit
 *                   Shift) and is held for kDefaultTapMs. 'H' and 'W' sent
 *                   back-to-back are down at the same time.
 *   0x01 k          PRESS k   held until RELEASE; auto-released after
 *                             kHoldSafetyMs unless re-sent (host keepalive)
 *   0x02 k          RELEASE k
 *   0x03 k lo hi    TAP k for (hi << 8 | lo) ms, 0 → kDefaultTapMs
 *   0x04            RELEASE ALL
 *   0x05            PING      → 0x06
 *   other bytes (\r, \n, ...) are ignored.
 * k is an Arduino Keyboard key value: ASCII or a KEY_* constant
 * (KEY_LEFT_SHIFT = 0x81, KEY_ESC = 0xB1, KEY_F1 = 0xC2, ...).
 *
 * Pico → host
 *   0x06 PONG, 0x15 NAK (all slots busy, key dropped).
 *
 * Re-sending a key that is already down only moves its deadline later; it
 * never produces a second press report, so a vision loop can stream 'W' every
 * frame and the key simply stays down.
 */
#include <Keyboard.h>

namespace cfg {
constexpr uint32_t kDefaultTapMs   = 50;
constexpr uint32_t kHoldSafetyMs   = 5000;  // dead-man timer for PRESS
constexpr uint32_t kFrameTimeoutMs = 20;    // drop a half-received frame after this
constexpr uint8_t  kSlots          = 6;     // boot keyboard report = 6 keys
constexpr int      kRxBurst        = 64;    // max bytes parsed per loop() pass
}  // namespace cfg

namespace op {
constexpr uint8_t kPress      = 0x01;
constexpr uint8_t kRelease    = 0x02;
constexpr uint8_t kTap        = 0x03;
constexpr uint8_t kReleaseAll = 0x04;
constexpr uint8_t kPing       = 0x05;
constexpr uint8_t kPong       = 0x06;
constexpr uint8_t kNak        = 0x15;
}  // namespace op

// Legacy one-byte commands that need another key or duration than the default rule.
struct Bind {
  uint8_t  cmd;
  uint8_t  key;
  uint16_t ms;
};
const Bind kBinds[] = {
  {'H', 'h', 80},      // heal: a bit longer so games polling input at 20 Hz still see it
  {'~', KEY_ESC, 50},
};

struct Slot {
  uint32_t start;
  uint32_t dur;
  uint8_t  key;
  bool     active;
};
Slot slots[cfg::kSlots];

uint32_t remaining(const Slot& s, uint32_t now) {
  const uint32_t elapsed = now - s.start;
  return elapsed >= s.dur ? 0 : s.dur - elapsed;
}

void keyDown(uint8_t key, uint32_t dur, uint32_t now) {
  Slot* freeSlot = nullptr;
  for (Slot& s : slots) {
    if (s.active && s.key == key) {
      if (dur > remaining(s, now)) {
        s.start = now;
        s.dur   = dur;
      }
      return;
    }
    if (!s.active && !freeSlot) freeSlot = &s;
  }
  if (!freeSlot) {
    Serial.write(op::kNak);
    return;
  }
  Keyboard.press(key);
  *freeSlot = {now, dur, key, true};
}

void keyUp(uint8_t key) {
  for (Slot& s : slots) {
    if (s.active && s.key == key) {
      Keyboard.release(key);
      s.active = false;
      return;
    }
  }
}

void allUp() {
  Keyboard.releaseAll();
  for (Slot& s : slots) s.active = false;
}

void expire(uint32_t now) {
  for (Slot& s : slots) {
    if (s.active && now - s.start >= s.dur) {
      Keyboard.release(s.key);
      s.active = false;
    }
  }
}

void legacyTap(uint8_t c, uint32_t now) {
  for (const Bind& b : kBinds) {
    if (b.cmd == c) {
      keyDown(b.key, b.ms, now);
      return;
    }
  }
  const uint8_t key = (c >= 'A' && c <= 'Z') ? c + ('a' - 'A') : c;
  keyDown(key, cfg::kDefaultTapMs, now);
}

enum class Rx : uint8_t { Idle, Key, DurLo, DurHi };

struct Parser {
  Rx       st    = Rx::Idle;
  uint8_t  opc   = 0;
  uint8_t  key   = 0;
  uint16_t dur   = 0;
  uint32_t since = 0;
} rx;

void feed(uint8_t b, uint32_t now) {
  switch (rx.st) {
    case Rx::Idle:
      switch (b) {
        case op::kPress:
        case op::kRelease:
        case op::kTap:
          rx.opc   = b;
          rx.st    = Rx::Key;
          rx.since = now;
          return;
        case op::kReleaseAll:
          allUp();
          return;
        case op::kPing:
          Serial.write(op::kPong);
          return;
        default:
          if (b >= 0x20 && b < 0x7F) legacyTap(b, now);
          return;
      }
    case Rx::Key:
      rx.key = b;
      if (rx.opc == op::kTap) {
        rx.st = Rx::DurLo;
        return;
      }
      if (rx.opc == op::kPress) keyDown(b, cfg::kHoldSafetyMs, now);
      else keyUp(b);
      rx.st = Rx::Idle;
      return;
    case Rx::DurLo:
      rx.dur = b;
      rx.st  = Rx::DurHi;
      return;
    case Rx::DurHi:
      rx.dur |= uint16_t(b) << 8;
      keyDown(rx.key, rx.dur ? rx.dur : cfg::kDefaultTapMs, now);
      rx.st = Rx::Idle;
      return;
  }
}

bool hostWasUp = false;

void setup() {
  Serial.begin(115200);  // baud is ignored on USB CDC; never wait for the host here
  Keyboard.begin();
}

void loop() {
  const uint32_t now = millis();

  // 1. Drain whatever the host sent. Bounded so expiry below is never starved.
  int n = Serial.available();
  if (n > cfg::kRxBurst) n = cfg::kRxBurst;
  while (n-- > 0) feed(uint8_t(Serial.read()), now);

  // 2. A frame cut off mid-way (host crashed, byte lost) must not swallow the next command.
  if (rx.st != Rx::Idle && now - rx.since > cfg::kFrameTimeoutMs) rx.st = Rx::Idle;

  // 3. Release keys whose time is up.
  expire(now);

  // 4. Host closed the port (DTR dropped: script exited or crashed) → nothing stays stuck down.
  const bool hostUp = bool(Serial);
  if (hostWasUp && !hostUp) {
    allUp();
    rx.st = Rx::Idle;
  }
  hostWasUp = hostUp;
}
