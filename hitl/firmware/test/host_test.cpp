// Host test for hands.ino:  g++ -std=c++17 -Imocks host_test.cpp -o host_test && ./host_test
#include <cstdio>
#include <initializer_list>

#include "Keyboard.h"
#include "../hands/hands.ino"

static int failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);    \
      ++failures;                                                      \
    }                                                                  \
  } while (0)

static void reset(uint32_t t = 0) {
  Keyboard = MockKeyboard{};
  Serial   = MockSerial{};
  g_now    = t;
  rx       = Parser{};
  hostWasUp = false;
  for (Slot& s : slots) s.active = false;
}

static void sendBytes(std::initializer_list<int> bytes) {
  for (int b : bytes) Serial.in.push_back(uint8_t(b));
}

static void runUntil(uint32_t t) {
  while (g_now < t) {
    loop();
    ++g_now;
  }
  loop();
}

static void testSimultaneousLegacy() {
  std::puts("simultaneous legacy H + W");
  reset();
  sendBytes({'H', 'W'});
  loop();
  CHECK(Keyboard.isDown('h'));
  CHECK(Keyboard.isDown('w'));
  runUntil(50);
  CHECK(!Keyboard.isDown('w'));  // default 50 ms
  CHECK(Keyboard.isDown('h'));   // kBinds: 80 ms
  runUntil(80);
  CHECK(!Keyboard.isDown('h'));
}

static void testRetriggerExtends() {
  std::puts("retrigger extends without a second press report");
  reset();
  sendBytes({'W'});
  runUntil(40);
  sendBytes({'W'});
  runUntil(60);
  CHECK(Keyboard.isDown('w'));
  runUntil(90);
  CHECK(!Keyboard.isDown('w'));
  CHECK(Keyboard.log.size() == 2);  // exactly "+w", "-w"
}

static void testBinaryTap() {
  std::puts("binary TAP with custom duration");
  reset();
  sendBytes({op::kTap, 'a', 0xF4, 0x01});  // 500 ms
  loop();
  CHECK(Keyboard.isDown('a'));
  runUntil(499);
  CHECK(Keyboard.isDown('a'));
  runUntil(500);
  CHECK(!Keyboard.isDown('a'));
}

static void testPressReleaseAndSafety() {
  std::puts("PRESS / RELEASE / dead-man timer");
  reset();
  sendBytes({op::kPress, KEY_LEFT_SHIFT});
  runUntil(1000);
  CHECK(Keyboard.isDown(KEY_LEFT_SHIFT));
  sendBytes({op::kRelease, KEY_LEFT_SHIFT});
  loop();
  CHECK(!Keyboard.isDown(KEY_LEFT_SHIFT));

  reset();
  sendBytes({op::kPress, 'w'});
  runUntil(cfg::kHoldSafetyMs - 1);
  CHECK(Keyboard.isDown('w'));
  runUntil(cfg::kHoldSafetyMs);
  CHECK(!Keyboard.isDown('w'));
}

static void testTapDoesNotShortenHold() {
  std::puts("TAP on a held key keeps the hold");
  reset();
  sendBytes({op::kPress, 'w'});
  runUntil(10);
  sendBytes({'W'});
  runUntil(200);
  CHECK(Keyboard.isDown('w'));
}

static void testSplitFrameAndResync() {
  std::puts("frame split across loops, then a truncated frame resyncs");
  reset();
  sendBytes({op::kTap});
  runUntil(5);
  sendBytes({'b'});
  runUntil(10);
  sendBytes({100, 0});
  loop();
  CHECK(Keyboard.isDown('b'));

  reset();
  sendBytes({op::kTap, 'c'});  // never completed
  runUntil(cfg::kFrameTimeoutMs + 1);
  sendBytes({'W'});
  loop();
  CHECK(Keyboard.isDown('w'));
  CHECK(!Keyboard.isDown('c'));
}

static void testSlotsExhaustedNak() {
  std::puts("7th key → NAK");
  reset();
  sendBytes({'A', 'B', 'C', 'D', 'E', 'F', 'G'});
  loop();
  CHECK(Keyboard.down.size() == 6);
  CHECK(!Keyboard.isDown('g'));
  CHECK(Serial.out.size() == 1 && Serial.out[0] == op::kNak);
}

static void testPingNewlineReleaseAll() {
  std::puts("PING, ignored newline, RELEASE ALL");
  reset();
  sendBytes({op::kPing, '\r', '\n', op::kPress, 'x'});
  loop();
  CHECK(Serial.out.size() == 1 && Serial.out[0] == op::kPong);
  CHECK(Keyboard.down.size() == 1);
  sendBytes({op::kReleaseAll});
  loop();
  CHECK(Keyboard.down.empty());
}

static void testHostLoss() {
  std::puts("host closes port → release all");
  reset();
  loop();  // hostWasUp = true
  sendBytes({op::kPress, 'w'});
  loop();
  CHECK(Keyboard.isDown('w'));
  Serial.connected = false;
  loop();
  CHECK(Keyboard.down.empty());
}

static void testMillisWrap() {
  std::puts("millis() wrap-around");
  reset(0xFFFFFFF0u);
  sendBytes({'W'});
  loop();
  for (int i = 0; i < 40; ++i) { ++g_now; loop(); }  // crosses 0
  CHECK(Keyboard.isDown('w'));
  for (int i = 0; i < 10; ++i) { ++g_now; loop(); }
  CHECK(!Keyboard.isDown('w'));
}

int main() {
  testSimultaneousLegacy();
  testRetriggerExtends();
  testBinaryTap();
  testPressReleaseAndSafety();
  testTapDoesNotShortenHold();
  testSplitFrameAndResync();
  testSlotsExhaustedNak();
  testPingNewlineReleaseAll();
  testHostLoss();
  testMillisWrap();
  std::printf(failures ? "\n%d FAILURE(S)\n" : "\nall firmware tests passed\n", failures);
  return failures ? 1 : 0;
}
