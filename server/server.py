"""
Kindle Deck - serwer na PC (Windows).

Serwuje interfejs webowy dla tabletu i wystawia proste REST API:
  GET  /api/ping                 - heartbeat (status "PC Connected")
  GET  /api/config               - przyciski + ustawienia pomodoro
  POST /api/action/<id>          - wykonaj akcję przypisaną do przycisku
  GET  /api/todos                - lista zadań
  POST /api/todos                - dodaj {"text": "..."}
  POST /api/todos/<id>/toggle    - odhacz / przywróć
  DELETE /api/todos/<id>         - usuń
  POST /api/todos/clear_done     - usuń wszystkie zrobione
  GET  /api/weather              - pogoda (proxy Open-Meteo, cache 10 min)
  GET  /api/events               - nadchodzące wydarzenia (Google Calendar ICS)
  POST /api/events/<id>/join     - otwórz link spotkania na PC

Pogoda i kalendarz idą PRZEZ serwer celowo: stary Fire OS ma przestarzałe
TLS/certyfikaty i często nie dogada się z nowoczesnym HTTPS. Tablet gada
tylko z PC po zwykłym HTTP w LAN.
"""
import datetime as dt
import functools
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import socket
import sys
import threading
import time
import uuid

import requests
from flask import Flask, abort, jsonify, request, send_from_directory

from actions import ActionError, run_action

BASE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.normpath(os.path.join(BASE, "..", "web"))
CONFIG_PATH = os.path.join(BASE, "config.json")
CONFIG_EXAMPLE = os.path.join(BASE, "config.example.json")
TODO_PATH = os.path.join(BASE, "todos.json")

if sys.stdout is None:  # pythonw.exe (start_hidden.vbs) nie ma konsoli -> log do pliku
    sys.stdout = sys.stderr = open(os.path.join(BASE, "deck.log"), "a", encoding="utf-8", buffering=1)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("deck")


# --- konfiguracja ------------------------------------------------------------

def load_config():
    if not os.path.exists(CONFIG_PATH):
        shutil.copy(CONFIG_EXAMPLE, CONFIG_PATH)
        log.warning("Utworzono config.json z przykładu - ZMIEŃ token i przyciski!")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


CFG = load_config()
app = Flask(__name__, static_folder=None)


def require_token(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        expected = CFG.get("token") or ""
        if expected:
            got = request.headers.get("X-Deck-Token") or request.args.get("token") or ""
            if not hmac.compare_digest(got.encode(), expected.encode()):
                return jsonify(ok=False, error="unauthorized"), 401
        return fn(*a, **kw)

    return wrapper


@app.after_request
def no_cache(resp):
    # stare WebView potrafią agresywnie cache'ować GET-y z API
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --- frontend ---------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:name>")
def static_files(name):
    return send_from_directory(WEB_DIR, name)


# --- heartbeat + config ------------------------------------------------------

@app.route("/api/ping")
@require_token
def ping():
    return jsonify(ok=True, host=socket.gethostname(), now=int(time.time() * 1000))


@app.route("/api/config")
@require_token
def get_config():
    buttons = [
        {k: b.get(k) for k in ("id", "label", "icon", "color", "sub")}
        for b in CFG.get("buttons", [])
    ]
    return jsonify(
        ok=True,
        buttons=buttons,
        pomodoro=CFG.get("pomodoro", {}),
        location=(CFG.get("weather") or {}).get("name", ""),
    )


@app.route("/api/action/<button_id>", methods=["POST"])
@require_token
def do_action(button_id):
    # hidden_actions: akcje bez przycisku na siatce (np. hooki Pomodoro)
    pool = CFG.get("buttons", []) + CFG.get("hidden_actions", [])
    btn = next((b for b in pool if b.get("id") == button_id), None)
    if btn is None:
        return jsonify(ok=False, error="nie ma przycisku %s" % button_id), 404
    try:
        result = run_action(btn.get("action"), CFG)
        return jsonify(ok=True, result=result)
    except ActionError as exc:
        log.warning("akcja %s nieudana: %s", button_id, exc)
        return jsonify(ok=False, error=str(exc)), 500
    except Exception as exc:  # nie wywracaj serwera przez jeden przycisk
        log.exception("akcja %s wywaliła się", button_id)
        return jsonify(ok=False, error=str(exc)), 500


# --- to-do --------------------------------------------------------------------

_todo_lock = threading.Lock()


def _load_todos():
    if not os.path.exists(TODO_PATH):
        return []
    with open(TODO_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_todos(items):
    tmp = TODO_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, TODO_PATH)  # atomowo - prąd zgaśnie, plik zostanie cały


@app.route("/api/todos", methods=["GET"])
@require_token
def todos_list():
    with _todo_lock:
        return jsonify(ok=True, items=_load_todos())


@app.route("/api/todos", methods=["POST"])
@require_token
def todos_add():
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()[:200]
    if not text:
        return jsonify(ok=False, error="pusty tekst"), 400
    with _todo_lock:
        items = _load_todos()
        items.append({"id": uuid.uuid4().hex[:10], "text": text, "done": False,
                      "created": int(time.time())})
        _save_todos(items)
        return jsonify(ok=True, items=items)


@app.route("/api/todos/<tid>/toggle", methods=["POST"])
@require_token
def todos_toggle(tid):
    with _todo_lock:
        items = _load_todos()
        for it in items:
            if it["id"] == tid:
                it["done"] = not it["done"]
        _save_todos(items)
        return jsonify(ok=True, items=items)


@app.route("/api/todos/<tid>", methods=["DELETE"])
@require_token
def todos_delete(tid):
    with _todo_lock:
        items = [it for it in _load_todos() if it["id"] != tid]
        _save_todos(items)
        return jsonify(ok=True, items=items)


@app.route("/api/todos/clear_done", methods=["POST"])
@require_token
def todos_clear_done():
    with _todo_lock:
        items = [it for it in _load_todos() if not it["done"]]
        _save_todos(items)
        return jsonify(ok=True, items=items)


# --- prosty cache dla zewnętrznych API --------------------------------------

_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, producer):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    value = producer()
    with _cache_lock:
        _cache[key] = (time.time(), value)
    return value


def stale(key):
    hit = _cache.get(key)
    return hit[1] if hit else None


# --- pogoda (Open-Meteo, bez klucza API) -----------------------------------

WMO = {
    0: ("Bezchmurnie", "☀"), 1: ("Prawie bezchmurnie", "☀"), 2: ("Częściowe zachmurzenie", "⛅"),
    3: ("Pochmurno", "☁"), 45: ("Mgła", "≡"), 48: ("Szadź", "≡"),
    51: ("Lekka mżawka", "☂"), 53: ("Mżawka", "☂"), 55: ("Gęsta mżawka", "☂"),
    61: ("Słaby deszcz", "☂"), 63: ("Deszcz", "☂"), 65: ("Ulewa", "☔"),
    66: ("Marznący deszcz", "☂"), 67: ("Marznący deszcz", "☔"),
    71: ("Słaby śnieg", "❄"), 73: ("Śnieg", "❄"), 75: ("Intensywny śnieg", "❄"), 77: ("Ziarna śniegu", "❄"),
    80: ("Przelotny deszcz", "☂"), 81: ("Przelotne opady", "☂"), 82: ("Gwałtowne opady", "☔"),
    85: ("Przelotny śnieg", "❄"), 86: ("Śnieżyca", "❄"),
    95: ("Burza", "⚡"), 96: ("Burza z gradem", "⚡"), 99: ("Silna burza z gradem", "⚡"),
}


def _fetch_weather():
    w = CFG.get("weather") or {}
    r = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": w.get("lat", 52.23),
            "longitude": w.get("lon", 21.01),
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                       "weather_code,wind_speed_10m,is_day",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                     "precipitation_probability_max,sunrise,sunset",
            "timezone": "auto",
            "forecast_days": 3,
        },
        timeout=8,
    )
    r.raise_for_status()
    d = r.json()
    cur = d["current"]
    desc, icon = WMO.get(cur["weather_code"], ("?", "?"))
    if icon == "☀" and not cur.get("is_day", 1):
        icon = "☾"
    daily = d["daily"]
    days = []
    for i in range(len(daily["time"])):
        dd, di = WMO.get(daily["weather_code"][i], ("?", "?"))
        days.append({
            "date": daily["time"][i],
            "icon": di, "desc": dd,
            "tmax": round(daily["temperature_2m_max"][i]),
            "tmin": round(daily["temperature_2m_min"][i]),
            "rain": daily["precipitation_probability_max"][i],
        })
    return {
        "temp": round(cur["temperature_2m"]),
        "feels": round(cur["apparent_temperature"]),
        "humidity": cur["relative_humidity_2m"],
        "wind": round(cur["wind_speed_10m"]),
        "desc": desc, "icon": icon,
        "sunrise": daily["sunrise"][0][-5:], "sunset": daily["sunset"][0][-5:],
        "days": days,
        "updated": int(time.time()),
    }


@app.route("/api/weather")
@require_token
def weather():
    try:
        return jsonify(ok=True, **cached("weather", 600, _fetch_weather))
    except Exception as exc:
        log.warning("pogoda: %s", exc)
        old = stale("weather")
        if old:
            return jsonify(ok=True, stale=True, **old)
        return jsonify(ok=False, error=str(exc)), 502


# --- kalendarz (Google Calendar -> "Tajny adres w formacie iCal") -----------

LINK_RE = re.compile(r"https?://[^\s<>\"'\\]+")
MEETING_HOSTS = ("meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com",
                 "discord.gg", "discord.com", "webex.com", "whereby.com", "jitsi")
_event_links = {}  # id wydarzenia -> link (tablet nie może podać dowolnego URL)


def _find_link(ev):
    texts = [str(ev.get(k, "")) for k in ("X-GOOGLE-CONFERENCE", "URL", "LOCATION", "DESCRIPTION")]
    found = []
    for t in texts:
        found += LINK_RE.findall(t)
    for url in found:
        if any(h in url for h in MEETING_HOSTS):
            return url.rstrip(".,;)")
    return None


def _to_local(value):
    """date -> (datetime o północy, all_day=True); datetime -> lokalny naive."""
    if isinstance(value, dt.datetime):
        if value.tzinfo is not None:
            value = value.astimezone().replace(tzinfo=None)
        return value, False
    return dt.datetime(value.year, value.month, value.day), True


def _fetch_events():
    url = CFG.get("calendar_ics_url") or ""
    if not url:
        return []
    import icalendar

    r = requests.get(url, timeout=10)
    r.raise_for_status()
    cal = icalendar.Calendar.from_ical(r.content)

    now = dt.datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=int(CFG.get("calendar_days", 7)))

    try:
        import recurring_ical_events
        components = recurring_ical_events.of(cal).between(start, end)
    except ImportError:  # bez rozwijania wydarzeń cyklicznych
        components = cal.walk("VEVENT")

    out = []
    for ev in components:
        if "DTSTART" not in ev:
            continue
        s, all_day = _to_local(ev["DTSTART"].dt)
        e = _to_local(ev["DTEND"].dt)[0] if "DTEND" in ev else s + dt.timedelta(hours=1)
        if e < now or s > end:
            continue
        link = _find_link(ev)
        eid = hashlib.sha1(("%s|%s" % (ev.get("UID", ""), s.isoformat())).encode()).hexdigest()[:12]
        if link:
            _event_links[eid] = link
        out.append({
            "id": eid,
            "title": str(ev.get("SUMMARY", "(bez tytułu)")),
            "start": s.strftime("%Y-%m-%dT%H:%M:%S"),
            "end": e.strftime("%Y-%m-%dT%H:%M:%S"),
            "all_day": all_day,
            "has_link": bool(link),
        })
    out.sort(key=lambda x: (x["start"], x["title"]))
    return out[: int(CFG.get("calendar_max", 15))]


@app.route("/api/events")
@require_token
def events():
    try:
        return jsonify(ok=True, items=cached("events", 300, _fetch_events),
                       configured=bool(CFG.get("calendar_ics_url")))
    except Exception as exc:
        log.warning("kalendarz: %s", exc)
        old = stale("events")
        if old is not None:
            return jsonify(ok=True, stale=True, items=old, configured=True)
        return jsonify(ok=False, error=str(exc)), 502


@app.route("/api/events/<eid>/join", methods=["POST"])
@require_token
def event_join(eid):
    link = _event_links.get(eid)
    if not link:
        abort(404)
    run_action({"type": "url", "url": link}, CFG)
    return jsonify(ok=True, url=link)


# --- start --------------------------------------------------------------------

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # nic nie wysyła, tylko wybiera interfejs
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    host = CFG.get("host", "0.0.0.0")
    port = int(CFG.get("port", 8765))
    token = CFG.get("token") or ""
    url = "http://%s:%d/" % (lan_ip(), port)
    if token:
        url += "?token=" + token
    print("\n  Kindle Deck działa. Otwórz na tablecie:\n\n    %s\n" % url)
    if not token or token == "zmien-mnie":
        log.warning("Ustaw własny 'token' w config.json!")
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
