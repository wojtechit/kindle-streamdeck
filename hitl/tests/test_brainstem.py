"""Brainstem tests without hardware:  python -m pytest hitl/tests  (or run this file directly)."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "brainstem"))
import brainstem as bs  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class FakeSerial:
    """Records writes; answers PING with PONG like the Pico does."""

    def __init__(self) -> None:
        self.written = bytearray()
        self.writes = 0
        self._rx = bytearray()
        self._cv = threading.Condition()

    def write(self, data: bytes) -> int:
        with self._cv:
            self.written += data
            self.writes += 1
            if bs.OP_PING in data:
                self._rx.append(bs.PONG)
            self._cv.notify_all()
        return len(data)

    def read(self, n: int) -> bytes:
        with self._cv:
            self._cv.wait_for(lambda: self._rx, timeout=0.05)
            out, self._rx = bytes(self._rx[:n]), self._rx[n:]
            return out

    def close(self) -> None:
        pass

    def wait_bytes(self, n: int, timeout: float = 1.0) -> bytes:
        with self._cv:
            self._cv.wait_for(lambda: len(self.written) >= n, timeout)
            return bytes(self.written)


def make_link(keepalive_s: float = 1.0) -> tuple[bs.SerialLink, FakeSerial]:
    fake = FakeSerial()
    link = bs.SerialLink("fake://", keepalive_s=keepalive_s, opener=lambda _u: fake)
    link.start()
    return link, fake


def test_encoding() -> None:
    assert bs.encode_tap("W", 500) == bytes([0x03, ord("w"), 0xF4, 0x01])
    assert bs.key_code("shift") == 0x81
    assert bs.key_code("F12") == 0xCD
    for bad in ("nope", "ż"):
        try:
            bs.key_code(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_link_coalesces_and_orders() -> None:
    link, fake = make_link()
    link._open()  # connect before the burst so the TX thread sees it in one drain
    link.legacy("H")
    link.legacy("W")
    link.press("shift")
    link.tap("e", 30)
    expected = b"HW" + bytes([0x01, 0x81, 0x03, ord("e"), 30, 0])
    assert fake.wait_bytes(len(expected)) == expected
    assert link.writes <= 2  # first put wakes TX; the rest ride along
    link.stop()


def test_keepalive_resends_held_keys_only() -> None:
    link, fake = make_link(keepalive_s=0.05)
    link.press("w")
    link.press("shift")
    link.release("shift")
    time.sleep(0.2)
    data = fake.wait_bytes(1)
    tail = data[6:]  # after PRESS w, PRESS shift, RELEASE shift
    assert tail and tail.count(bytes([0x01, ord("w")])) >= 2
    assert bytes([0x01, 0x81]) not in tail
    link.stop()


def test_ping_roundtrip() -> None:
    link, _ = make_link()
    rtt = link.ping()
    assert rtt is not None and rtt < 0.5
    link.stop()


def test_latest_frame_skips_stale() -> None:
    box = bs.LatestFrame()
    img = np.zeros((2, 2, 3), np.uint8)
    for _ in range(5):
        box.publish(img, time.perf_counter())
    f = box.wait_newer(0, 0.1)
    assert f is not None and f.seq == 5
    assert box.wait_newer(5, 0.01) is None
    threading.Timer(0.02, box.publish, (img, time.perf_counter())).start()
    f = box.wait_newer(5, 1.0)
    assert f is not None and f.seq == 6


class StaticSource(bs.FrameSource):
    def __init__(self, img: np.ndarray) -> None:
        super().__init__("capture-test")
        self.img = img

    def run(self) -> None:
        while not self._halt.is_set():
            self._publish(self.img)
            time.sleep(0.002)


def test_health_reflex_fires_with_cooldown() -> None:
    link, fake = make_link()
    frame = np.zeros((100, 200, 3), np.uint8)
    frame[10:20, 10:40] = (0, 0, 255)  # 30 % red bar in a 100 px ROI
    src = StaticSource(frame)
    brain = bs.Brainstem(src, link, [bs.LowHealthReflex((10, 10, 100, 10), threshold=0.35, cooldown_s=10)])
    src.start()
    t = threading.Thread(target=brain.run, daemon=True)
    t.start()
    time.sleep(0.15)
    brain.stop()
    src.stop()
    t.join(1)
    assert brain.frames > 5
    assert fake.wait_bytes(1).count(b"H") == 1
    assert brain.latency_ms < 50
    link.stop()


def test_api_http_and_ws() -> None:
    link, fake = make_link()
    client = TestClient(bs.create_app(link))
    assert client.post("/cmd", json={"key": "W"}).json() == {"ok": True}
    assert client.post("/cmd", json={"key": "w", "action": "press"}).status_code == 200
    assert client.post("/cmd", json={"key": "bogus"}).status_code == 400
    assert client.post("/cmd", json={"key": "a", "ms": 70000}).status_code == 422
    assert client.post("/batch", json=[{"key": "a"}, {"key": "bogus"}]).status_code == 400
    assert client.post("/batch", json=[{"key": "a", "ms": 10}, {"key": "w", "action": "release"}]).json()["n"] == 2
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"key": "e", "ms": 5})
        ws.send_json({"key": "???"})
        assert "error" in ws.receive_json()
    assert client.post("/release_all").json() == {"ok": True}
    assert client.get("/ping").json()["rtt_ms"] is not None

    expected = (bs.encode_tap("w") + bytes([0x01, ord("w")]) + bs.encode_tap("a", 10)
                + bytes([0x02, ord("w")]) + bs.encode_tap("e", 5) + bytes([0x04, 0x05]))
    assert fake.wait_bytes(len(expected)) == expected
    link.stop()


def test_api_server_thread_serves() -> None:
    import socket

    import httpx

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    link, _ = make_link()
    api = bs.ApiServer(bs.create_app(link), "127.0.0.1", port)
    api.start()
    for _ in range(100):
        if api.server.started:
            break
        time.sleep(0.02)
    with httpx.Client(base_url=f"http://127.0.0.1:{port}") as c:
        c.post("/cmd", json={"key": "w"})  # warm-up
        n = 500
        t0 = time.perf_counter()
        for _ in range(n):
            c.post("/cmd", json={"key": "w"})
        per_req_us = (time.perf_counter() - t0) / n * 1e6
    print(f"\n  keep-alive HTTP POST /cmd round trip: {per_req_us:.0f} µs")
    api.stop()
    api.join(2)
    link.stop()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
