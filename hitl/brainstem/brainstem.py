#!/usr/bin/env python3
"""Brainstem: vision reflexes + Cortex HTTP/WebSocket API → USB serial → Pico "Hands".

Threads (no busy-waiting and no sleep() anywhere on the hot path):

  capture    FrameSource    camera / desktop → LatestFrame mailbox (stale frames are overwritten)
  main       Brainstem      waits for a *newer* frame → reflexes → SerialLink.send()
  serial-tx  SerialLink     SimpleQueue → one coalesced write() per wake-up, held-key keepalive
  serial-rx  SerialLink     PONG / NAK coming back from the Pico
  api        ApiServer      uvicorn + FastAPI on its own asyncio loop → SerialLink.send()

Nobody waits on anybody else: capture never waits for vision, vision and the API never
wait for the serial port. The only shared objects are the mailbox (one Condition) and
a lock-free-ish SimpleQueue.
"""
from __future__ import annotations

import argparse
import logging
import queue
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Literal

import cv2
import numpy as np
import serial
import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger("brainstem")

# ─── Wire protocol (mirror of firmware/hands/hands.ino) ──────────────────────

OP_PRESS, OP_RELEASE, OP_TAP, OP_RELEASE_ALL, OP_PING = 0x01, 0x02, 0x03, 0x04, 0x05
PONG, NAK = 0x06, 0x15

# Arduino Keyboard.h key values. Printable ASCII is passed through as-is.
KEYS: dict[str, int] = {
    "ctrl": 0x80, "shift": 0x81, "alt": 0x82, "gui": 0x83,
    "rctrl": 0x84, "rshift": 0x85, "ralt": 0x86, "rgui": 0x87,
    "up": 0xDA, "down": 0xD9, "left": 0xD8, "right": 0xD7,
    "enter": 0xB0, "esc": 0xB1, "backspace": 0xB2, "tab": 0xB3, "space": 0x20,
    "insert": 0xD1, "home": 0xD2, "pageup": 0xD3, "delete": 0xD4, "end": 0xD5, "pagedown": 0xD6,
    **{f"f{i}": 0xC1 + i for i in range(1, 13)},
}


def key_code(key: str) -> int:
    k = key.lower()  # 'W' would make the Pico add Shift; we always mean the bare key
    if k in KEYS:
        return KEYS[k]
    if len(k) == 1 and 0x20 <= ord(k) < 0x7F:
        return ord(k)
    raise ValueError(f"unknown key: {key!r}")


def encode_tap(key: str, ms: int = 0) -> bytes:
    if not 0 <= ms <= 0xFFFF:
        raise ValueError(f"ms out of range: {ms}")
    return bytes((OP_TAP, key_code(key))) + ms.to_bytes(2, "little")


# ─── Serial link ─────────────────────────────────────────────────────────────


class SerialLink:
    """Owns the serial port. send() is a non-blocking enqueue callable from any thread.

    The TX thread drains *everything* pending into one write(), so a burst of
    commands from vision and the API costs one syscall and usually one USB packet.
    Keys held with press() are re-sent every `keepalive_s` to feed the Pico's
    dead-man timer (5 s): if this process hangs, the keys come up on their own.
    """

    def __init__(
        self,
        url: str,
        keepalive_s: float = 1.0,
        opener: Callable[[str], serial.SerialBase] | None = None,
    ):
        self._url = url
        self._keepalive_s = keepalive_s
        self._opener = opener or (
            lambda u: serial.serial_for_url(u, baudrate=115200, timeout=0.1, write_timeout=0.05)
        )
        self._q: queue.SimpleQueue[bytes] = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._held: set[int] = set()
        self._ser: serial.SerialBase | None = None
        self._connected = threading.Event()
        self._halt = threading.Event()
        self._pong = threading.Event()
        self._pong_t = 0.0
        self.writes = 0
        self.bytes_out = 0
        self.dropped = 0
        self.naks = 0
        self._threads = [
            threading.Thread(target=self._tx_loop, name="serial-tx", daemon=True),
            threading.Thread(target=self._rx_loop, name="serial-rx", daemon=True),
        ]

    # public, thread-safe, never blocks ------------------------------------
    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def send(self, data: bytes) -> None:
        self._q.put(data)

    def legacy(self, cmd: str) -> None:
        self.send(cmd.encode("ascii"))

    def tap(self, key: str, ms: int = 0) -> None:
        self.send(encode_tap(key, ms))

    def press(self, key: str) -> None:
        k = key_code(key)
        with self._lock:
            self._held.add(k)
            self.send(bytes((OP_PRESS, k)))

    def release(self, key: str) -> None:
        k = key_code(key)
        with self._lock:
            self._held.discard(k)
            self.send(bytes((OP_RELEASE, k)))

    def release_all(self) -> None:
        with self._lock:
            self._held.clear()
            self.send(bytes((OP_RELEASE_ALL,)))

    def ping(self, timeout: float = 0.5) -> float | None:
        """Host → Pico → host round trip in seconds (blocking; don't call from async code)."""
        self._pong.clear()
        t0 = time.perf_counter()
        self.send(bytes((OP_PING,)))
        return self._pong_t - t0 if self._pong.wait(timeout) else None

    # lifecycle --------------------------------------------------------------
    def start(self) -> None:
        for t in self._threads:
            t.start()

    def stop(self) -> None:
        self.release_all()
        time.sleep(0.05)  # shutdown only: let TX flush RELEASE_ALL
        self._halt.set()
        for t in self._threads:
            t.join(timeout=1.0)
        self._close()

    # internals ----------------------------------------------------------------
    def _open(self) -> serial.SerialBase | None:
        if self._ser is not None:
            return self._ser
        try:
            self._ser = self._opener(self._url)
        except (serial.SerialException, OSError) as e:
            log.warning("serial %s unavailable: %s", self._url, e)
            return None
        log.info("serial %s open", self._url)
        self._connected.set()
        return self._ser

    def _close(self) -> None:
        self._connected.clear()
        ser, self._ser = self._ser, None
        with self._lock:
            self._held.clear()  # the Pico released everything when DTR dropped
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def _tx_loop(self) -> None:
        next_ka = time.monotonic() + self._keepalive_s
        retry_at = 0.0
        while not self._halt.is_set():
            buf = bytearray()
            try:
                buf += self._q.get(timeout=max(0.0, next_ka - time.monotonic()))
                while True:
                    buf += self._q.get_nowait()
            except queue.Empty:
                pass
            now = time.monotonic()
            if now >= next_ka:
                next_ka = now + self._keepalive_s
                with self._lock:
                    buf += b"".join(bytes((OP_PRESS, k)) for k in self._held)
            if not buf:
                continue
            ser = self._ser
            if ser is None and now >= retry_at:
                ser = self._open()
                retry_at = now + 1.0
            if ser is None:
                self.dropped += len(buf)  # stale reflexes are worse than none
                continue
            try:
                ser.write(buf)
                self.writes += 1
                self.bytes_out += len(buf)
            except (serial.SerialException, OSError) as e:
                log.warning("serial write failed: %s", e)
                self.dropped += len(buf)
                self._close()

    def _rx_loop(self) -> None:
        while not self._halt.is_set():
            ser = self._ser
            if ser is None:
                self._connected.wait(0.5)
                continue
            try:
                data = ser.read(64)  # returns after 100 ms timeout or as soon as bytes arrive
            except (serial.SerialException, OSError, TypeError, AttributeError):
                if ser is self._ser:
                    self._close()
                continue
            for b in data:
                if b == PONG:
                    self._pong_t = time.perf_counter()
                    self._pong.set()
                elif b == NAK:
                    self.naks += 1


# ─── Frame capture (producer side) ───────────────────────────────────────────


@dataclass(slots=True, frozen=True)
class Frame:
    seq: int
    t_capture: float  # perf_counter() right after the driver handed us the frame
    image: np.ndarray


class LatestFrame:
    """Single-slot mailbox. The producer overwrites, consumers block until something newer exists.

    Unlike Queue(maxsize=1) the producer never blocks and never has to do the
    racy "get the old one out, then put" dance; a slow consumer just skips frames.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._frame: Frame | None = None

    def publish(self, image: np.ndarray, t_capture: float) -> None:
        with self._cond:
            seq = self._frame.seq + 1 if self._frame else 1
            self._frame = Frame(seq, t_capture, image)
            self._cond.notify_all()

    def wait_newer(self, seq: int, timeout: float) -> Frame | None:
        with self._cond:
            ok = self._cond.wait_for(lambda: self._frame is not None and self._frame.seq > seq, timeout)
            return self._frame if ok else None


class FrameSource(threading.Thread):
    def __init__(self, name: str) -> None:
        super().__init__(name=name, daemon=True)
        self.mailbox = LatestFrame()
        self.fps = 0.0
        self._halt = threading.Event()
        self._fps_n = 0
        self._fps_t = time.perf_counter()

    def stop(self) -> None:
        self._halt.set()

    def _publish(self, image: np.ndarray) -> None:
        now = time.perf_counter()
        self.mailbox.publish(image, now)
        self._fps_n += 1
        if now - self._fps_t >= 1.0:
            self.fps = self._fps_n / (now - self._fps_t)
            self._fps_n, self._fps_t = 0, now


class OpenCVSource(FrameSource):
    """OBS Virtual Camera (or any webcam) via OpenCV. cap.read() releases the GIL while it waits."""

    def __init__(self, index: int = 0, width: int = 0, height: int = 0, fps: int = 0) -> None:
        super().__init__("capture-opencv")
        self._index, self._w, self._h, self._fps_req = index, width, height, fps

    def _open(self) -> cv2.VideoCapture | None:
        # DirectShow: the OBS Virtual Camera is a DShow filter; MSMF opens slowly and buffers more.
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(self._index, backend)
        if not cap.isOpened():
            log.warning("camera %d not available", self._index)
            return None
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # don't let the driver queue stale frames
        if self._w and self._h:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._w)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._h)
        if self._fps_req:
            cap.set(cv2.CAP_PROP_FPS, self._fps_req)
        return cap

    def run(self) -> None:
        while not self._halt.is_set():
            cap = self._open()
            if cap is None:
                self._halt.wait(1.0)
                continue
            try:
                while not self._halt.is_set():
                    ok, img = cap.read()
                    if not ok:
                        log.warning("camera read failed, reopening")
                        break
                    self._publish(img)
            finally:
                cap.release()


class DXCamSource(FrameSource):
    """Desktop Duplication API via dxcam (Windows): grabs the game straight from DXGI,
    skipping OBS compositing → virtual camera → DirectShow → decode entirely.

    Note: frames are views into dxcam's ring buffer (default 64 slots); copy one if
    you keep it longer than a few dozen frames.
    """

    def __init__(self, output: int = 0, region: tuple[int, int, int, int] | None = None, fps: int = 120) -> None:
        super().__init__("capture-dxcam")
        self._output, self._region, self._fps_req = output, region, fps

    def run(self) -> None:
        import dxcam  # Windows-only; imported lazily so the rest runs anywhere

        cam = dxcam.create(output_idx=self._output, output_color="BGR")
        cam.start(region=self._region, target_fps=self._fps_req, video_mode=False)
        try:
            while not self._halt.is_set():
                img = cam.get_latest_frame()  # blocks until DXGI reports a changed frame
                if img is not None:
                    self._publish(img)
        finally:
            cam.stop()


# ─── Vision (consumer side) ──────────────────────────────────────────────────


class Reflex:
    """A vision rule with its own cooldown, so a 120 fps loop doesn't spam the Pico."""

    cooldown_s = 0.0

    def __init__(self) -> None:
        self._ready_at = 0.0

    def check(self, img: np.ndarray) -> bool:
        raise NotImplementedError

    def fire(self, link: SerialLink) -> None:
        raise NotImplementedError

    def step(self, img: np.ndarray, now: float, link: SerialLink) -> bool:
        if now < self._ready_at or not self.check(img):
            return False
        self._ready_at = now + self.cooldown_s
        self.fire(link)
        return True


class LowHealthReflex(Reflex):
    """Taps heal when the red fill of the health-bar ROI drops below `threshold`.

    Works on the ROI only (a few thousand pixels), never on the full frame.
    Tune the colour test for your HUD.
    """

    def __init__(self, roi: tuple[int, int, int, int], threshold: float = 0.35, cmd: str = "H", cooldown_s: float = 1.0):
        super().__init__()
        self.roi, self.threshold, self.cmd, self.cooldown_s = roi, threshold, cmd, cooldown_s
        self.last_fill = 1.0

    def check(self, img: np.ndarray) -> bool:
        x, y, w, h = self.roi
        patch = img[y : y + h, x : x + w].astype(np.int16)
        if patch.size == 0:
            return False
        b, g, r = patch[..., 0], patch[..., 1], patch[..., 2]
        self.last_fill = float(((r > 140) & (r - g > 70) & (r - b > 70)).mean())
        return self.last_fill < self.threshold

    def fire(self, link: SerialLink) -> None:
        link.legacy(self.cmd)


class Brainstem:
    def __init__(self, source: FrameSource, link: SerialLink, reflexes: list[Reflex]) -> None:
        self.source, self.link, self.reflexes = source, link, reflexes
        self.reflexes_enabled = threading.Event()
        self.reflexes_enabled.set()
        self.frames = 0
        self.skipped = 0
        self.latency_ms = 0.0  # EMA: frame handed to us by the driver → reflex decision done
        self._halt = threading.Event()

    def stop(self) -> None:
        self._halt.set()

    def run(self) -> None:
        seq = 0
        while not self._halt.is_set():
            f = self.source.mailbox.wait_newer(seq, timeout=0.5)
            if f is None:
                continue
            self.skipped += f.seq - seq - 1 if seq else 0
            seq = f.seq
            self.frames += 1
            if self.reflexes_enabled.is_set():
                now = time.perf_counter()
                for r in self.reflexes:
                    r.step(f.image, now, self.link)
            dt = (time.perf_counter() - f.t_capture) * 1000.0
            self.latency_ms += 0.05 * (dt - self.latency_ms)


# ─── Cortex API ──────────────────────────────────────────────────────────────


class Command(BaseModel):
    key: str
    action: Literal["tap", "press", "release"] = "tap"
    ms: int = Field(0, ge=0, le=0xFFFF)


class Toggle(BaseModel):
    enabled: bool


def create_app(link: SerialLink, brain: Brainstem | None = None) -> FastAPI:
    """All handlers are `async def` and only enqueue: they run inline on the event loop
    instead of hopping to the threadpool that plain `def` handlers would use."""
    app = FastAPI(title="Brainstem", version="2.0")
    actions = {
        "tap": lambda c: link.tap(c.key, c.ms),
        "press": lambda c: link.press(c.key),
        "release": lambda c: link.release(c.key),
    }

    def dispatch(c: Command) -> None:
        try:
            actions[c.action](c)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/cmd")
    async def cmd(c: Command) -> dict:
        dispatch(c)
        return {"ok": True}

    @app.post("/batch")
    async def batch(cs: list[Command]) -> dict:
        try:
            for c in cs:
                key_code(c.key)  # all-or-nothing: validate every key before sending any
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        for c in cs:
            dispatch(c)
        return {"ok": True, "n": len(cs)}

    @app.post("/release_all")
    async def release_all() -> dict:
        link.release_all()
        return {"ok": True}

    @app.post("/reflexes")
    async def reflexes(t: Toggle) -> dict:
        if brain is not None:
            (brain.reflexes_enabled.set if t.enabled else brain.reflexes_enabled.clear)()
        return {"ok": True, "enabled": t.enabled}

    @app.get("/ping")
    async def ping() -> dict:
        import asyncio

        rtt = await asyncio.to_thread(link.ping)
        return {"rtt_ms": None if rtt is None else round(rtt * 1000, 3)}

    @app.get("/status")
    async def status() -> dict:
        s = {
            "serial": {"connected": link.connected, "writes": link.writes, "bytes": link.bytes_out,
                       "dropped": link.dropped, "naks": link.naks},
        }
        if brain is not None:
            s["vision"] = {"capture_fps": round(brain.source.fps, 1), "frames": brain.frames,
                           "skipped": brain.skipped, "latency_ms": round(brain.latency_ms, 3),
                           "reflexes": brain.reflexes_enabled.is_set()}
        return s

    @app.websocket("/ws")
    async def ws(sock: WebSocket) -> None:
        """Persistent channel for the Cortex: one JSON Command (or list) per message,
        no HTTP request/response overhead. Silent on success, {"error": ...} on failure."""
        await sock.accept()
        try:
            while True:
                msg = await sock.receive_json()
                try:
                    for item in msg if isinstance(msg, list) else [msg]:
                        dispatch(Command.model_validate(item))
                except (ValidationError, HTTPException) as e:
                    await sock.send_json({"error": getattr(e, "detail", None) or str(e)})
        except WebSocketDisconnect:
            pass

    return app


class ApiServer(threading.Thread):
    """uvicorn on its own thread with its own asyncio loop (uvloop on Linux if installed).

    In-process on purpose: a separate process would need another IPC hop to reach
    the serial port, which only one process can hold open on Windows anyway.
    """

    def __init__(self, app: FastAPI, host: str, port: int) -> None:
        super().__init__(name="api", daemon=True)
        cfg = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False, lifespan="off")
        self.server = uvicorn.Server(cfg)

    def run(self) -> None:
        self.server.run()  # signal handlers are only installed on the main thread

    def stop(self) -> None:
        self.server.should_exit = True


# ─── Entry point ─────────────────────────────────────────────────────────────


def _ints(s: str, n: int) -> tuple[int, ...]:
    v = tuple(int(p) for p in s.split(","))
    if len(v) != n:
        raise argparse.ArgumentTypeError(f"expected {n} comma-separated ints")
    return v


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--serial", required=True, help="COM5, /dev/ttyACM0, or a pyserial URL like loop://")
    p.add_argument("--source", choices=("obs", "dxcam"), default="obs")
    p.add_argument("--camera", type=int, default=0, help="OpenCV index of the OBS Virtual Camera")
    p.add_argument("--size", type=lambda s: _ints(s, 2), help="W,H requested from the camera")
    p.add_argument("--fps", type=int, default=0, help="obs: requested fps; dxcam: target fps (default 120)")
    p.add_argument("--monitor", type=int, default=0, help="dxcam output index")
    p.add_argument("--region", type=lambda s: _ints(s, 4), help="dxcam capture region L,T,R,B")
    p.add_argument("--heal-roi", type=lambda s: _ints(s, 4), help="health bar X,Y,W,H in captured frame")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(threadName)s %(message)s")

    link = SerialLink(a.serial)
    if a.source == "dxcam":
        source: FrameSource = DXCamSource(a.monitor, a.region, a.fps or 120)
    else:
        w, h = a.size or (0, 0)
        source = OpenCVSource(a.camera, w, h, a.fps)
    reflexes: list[Reflex] = [LowHealthReflex(a.heal_roi)] if a.heal_roi else []
    brain = Brainstem(source, link, reflexes)
    api = ApiServer(create_app(link, brain), a.host, a.port)

    link.start()
    source.start()
    api.start()
    log.info("API on http://%s:%d  (docs: /docs, websocket: /ws)", a.host, a.port)
    try:
        brain.run()
    except KeyboardInterrupt:
        pass
    finally:
        brain.stop()
        source.stop()
        api.stop()
        link.stop()


if __name__ == "__main__":
    main()
