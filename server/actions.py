"""
Wykonawca akcji dla Kindle Deck.

Każda akcja to słownik z polem "type" zdefiniowany w config.json.
Tablet NIGDY nie wysyła komend do wykonania - wysyła tylko ID przycisku,
a serwer szuka akcji w swojej konfiguracji. Dzięki temu nikt w sieci
nie odpali dowolnego polecenia na PC.
"""
import logging
import os
import subprocess
import time
import webbrowser

import requests

log = logging.getLogger("deck.actions")

try:
    import pyautogui

    pyautogui.FAILSAFE = False  # nie przerywaj, gdy kursor jest w rogu ekranu
    pyautogui.PAUSE = 0.02
except Exception as exc:  # brak ekranu (np. test na Linuxie bez X) albo brak paczki
    pyautogui = None
    log.warning("pyautogui niedostępne (%s) - akcje klawiszowe wyłączone", exc)


class ActionError(Exception):
    pass


# --- klawiatura i media ----------------------------------------------------

MEDIA_KEYS = {
    "playpause": "playpause",
    "next": "nexttrack",
    "prev": "prevtrack",
    "stop": "stop",
    "volup": "volumeup",
    "voldown": "volumedown",
    "mute": "volumemute",
}


def _need_pyautogui():
    if pyautogui is None:
        raise ActionError("pyautogui nie działa na tym systemie")


def act_hotkey(action, cfg):
    """{"type": "hotkey", "keys": ["ctrl", "shift", "m"]}"""
    _need_pyautogui()
    keys = action.get("keys") or []
    if not keys:
        raise ActionError("hotkey: brak 'keys'")
    pyautogui.hotkey(*keys)
    return "+".join(keys)


def act_media(action, cfg):
    """{"type": "media", "key": "playpause|next|prev|stop|volup|voldown|mute"}"""
    _need_pyautogui()
    key = MEDIA_KEYS.get(action.get("key", ""))
    if not key:
        raise ActionError("media: nieznany klawisz %r" % action.get("key"))
    pyautogui.press(key, presses=int(action.get("repeat", 1)))
    return key


def act_type(action, cfg):
    """{"type": "type", "text": "gg wp"} - wpisuje tekst"""
    _need_pyautogui()
    pyautogui.write(action.get("text", ""), interval=0.01)
    return "typed"


# --- programy, pliki, linki ------------------------------------------------

def act_open(action, cfg):
    """
    {"type": "open", "target": "C:\\\\Program Files\\\\...\\\\app.exe"}
    {"type": "open", "target": "%USERPROFILE%\\\\Downloads"}
    {"type": "open", "target": "spotify:playlist:..."}   # URI zarejestrowane w Windows
    {"type": "open", "target": "steam://open/main"}
    """
    target = os.path.expandvars(action.get("target", ""))
    if not target:
        raise ActionError("open: brak 'target'")
    if hasattr(os, "startfile"):  # Windows
        os.startfile(target)
    else:  # fallback do testów na Linux/macOS
        subprocess.Popen(["xdg-open", target])
    return target


def act_url(action, cfg):
    """{"type": "url", "url": "https://..."} - otwiera w domyślnej przeglądarce"""
    url = action.get("url", "")
    if not url:
        raise ActionError("url: brak 'url'")
    webbrowser.open(url)
    return url


def act_shell(action, cfg):
    """
    {"type": "shell", "cmd": ["powershell", "-File", "C:\\\\skrypty\\\\backup.ps1"]}
    Komenda jako LISTA (bez shell=True) - zero problemów z cudzysłowami.
    """
    cmd = action.get("cmd")
    if not isinstance(cmd, list) or not cmd:
        raise ActionError("shell: 'cmd' musi być niepustą listą")
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    subprocess.Popen(
        [os.path.expandvars(c) for c in cmd],
        cwd=action.get("cwd"),
        creationflags=flags,
    )
    return " ".join(cmd)


# --- Home Assistant ----------------------------------------------------------

def act_ha(action, cfg):
    """
    {"type": "ha", "service": "light.toggle", "entity_id": "light.pokoj",
     "data": {"brightness_pct": 60}}
    """
    ha = cfg.get("home_assistant") or {}
    if not ha.get("url") or not ha.get("token"):
        raise ActionError("Home Assistant nie skonfigurowany (url/token)")
    domain, _, service = action.get("service", "").partition(".")
    if not domain or not service:
        raise ActionError("ha: 'service' w formacie domena.usluga")
    payload = dict(action.get("data") or {})
    if action.get("entity_id"):
        payload["entity_id"] = action["entity_id"]
    r = requests.post(
        "%s/api/services/%s/%s" % (ha["url"].rstrip("/"), domain, service),
        headers={"Authorization": "Bearer " + ha["token"]},
        json=payload,
        timeout=5,
    )
    if r.status_code >= 300:
        raise ActionError("HA %s: %s" % (r.status_code, r.text[:120]))
    return "%s.%s" % (domain, service)


# --- OBS Studio (obs-websocket v5, wbudowany w OBS 28+) ----------------------

_obs_client = None


def _obs(cfg):
    global _obs_client
    if _obs_client is None:
        try:
            import obsws_python as obs
        except ImportError:
            raise ActionError("brak paczki obsws-python (pip install obsws-python)")
        o = cfg.get("obs") or {}
        try:
            _obs_client = obs.ReqClient(
                host=o.get("host", "localhost"),
                port=int(o.get("port", 4455)),
                password=o.get("password", ""),
                timeout=3,
            )
        except Exception as exc:
            raise ActionError("OBS niedostępny: %s" % exc)
    return _obs_client


def _obs_call(cfg, fn):
    global _obs_client
    try:
        return fn(_obs(cfg))
    except ActionError:
        raise
    except Exception as exc:
        _obs_client = None  # OBS zamknięty/zrestartowany -> połącz od nowa następnym razem
        raise ActionError("OBS: %s" % exc)


def act_obs_scene(action, cfg):
    """{"type": "obs_scene", "scene": "Gra"}"""
    scene = action.get("scene")
    _obs_call(cfg, lambda c: c.set_current_program_scene(scene))
    return scene


def act_obs_mute(action, cfg):
    """{"type": "obs_mute", "input": "Mic/Aux"} - przełącza wyciszenie źródła"""
    name = action.get("input")
    _obs_call(cfg, lambda c: c.toggle_input_mute(name))
    return name


def act_obs_record(action, cfg):
    """{"type": "obs_record"} - start/stop nagrywania"""
    _obs_call(cfg, lambda c: c.toggle_record())
    return "record"


def act_obs_stream(action, cfg):
    """{"type": "obs_stream"} - start/stop streamu"""
    _obs_call(cfg, lambda c: c.toggle_stream())
    return "stream"


# --- makra -----------------------------------------------------------------

def act_multi(action, cfg):
    """
    {"type": "multi", "steps": [ {...akcja...}, {"type": "sleep", "s": 2}, {...} ]}
    """
    done = []
    for step in action.get("steps") or []:
        if step.get("type") == "multi":
            raise ActionError("multi w multi niedozwolone")
        done.append(run_action(step, cfg))
    return " > ".join(str(d) for d in done)


def act_sleep(action, cfg):
    s = min(float(action.get("s", 0.5)), 10.0)
    time.sleep(s)
    return "sleep %.1fs" % s


HANDLERS = {
    "hotkey": act_hotkey,
    "media": act_media,
    "type": act_type,
    "open": act_open,
    "url": act_url,
    "shell": act_shell,
    "ha": act_ha,
    "obs_scene": act_obs_scene,
    "obs_mute": act_obs_mute,
    "obs_record": act_obs_record,
    "obs_stream": act_obs_stream,
    "multi": act_multi,
    "sleep": act_sleep,
}


def run_action(action, cfg):
    t = (action or {}).get("type")
    handler = HANDLERS.get(t)
    if handler is None:
        raise ActionError("nieznany typ akcji %r" % t)
    log.info("akcja %s -> %s", t, action)
    return handler(action, cfg)
