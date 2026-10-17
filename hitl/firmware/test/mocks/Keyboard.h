// Host-side stand-ins for the arduino-pico Keyboard, Serial and millis() so
// hands.ino can be compiled and tested with plain g++.
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <string>
#include <vector>

constexpr uint8_t KEY_LEFT_CTRL  = 0x80;
constexpr uint8_t KEY_LEFT_SHIFT = 0x81;
constexpr uint8_t KEY_ESC        = 0xB1;

struct MockKeyboard {
  std::vector<std::string> log;  // "+h", "-h", "*" (release all)
  std::vector<uint8_t> down;

  void begin() {}
  size_t press(uint8_t k) {
    log.push_back("+" + std::string(1, char(k)));
    down.push_back(k);
    return 1;
  }
  size_t release(uint8_t k) {
    log.push_back("-" + std::string(1, char(k)));
    for (auto it = down.begin(); it != down.end(); ++it)
      if (*it == k) { down.erase(it); break; }
    return 1;
  }
  void releaseAll() {
    log.push_back("*");
    down.clear();
  }
  bool isDown(uint8_t k) const {
    for (uint8_t d : down) if (d == k) return true;
    return false;
  }
};

struct MockSerial {
  std::deque<uint8_t> in;
  std::vector<uint8_t> out;
  bool connected = true;

  void begin(unsigned long) {}
  int available() { return int(in.size()); }
  int read() {
    if (in.empty()) return -1;
    const uint8_t b = in.front();
    in.pop_front();
    return b;
  }
  size_t write(uint8_t b) {
    out.push_back(b);
    return 1;
  }
  explicit operator bool() const { return connected; }
};

inline MockKeyboard Keyboard;
inline MockSerial Serial;
inline uint32_t g_now = 0;
inline uint32_t millis() { return g_now; }
