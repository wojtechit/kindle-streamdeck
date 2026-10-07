/*
 * Kindle Deck - klient na tablet.
 * Celowo czysty ES5 (var, function, XMLHttpRequest, bez Promise/fetch/arrow),
 * żeby ruszył na starym Silk / WebView z Fire OS bez transpilacji.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function store(key, val) {
    try {
      if (arguments.length > 1) { localStorage.setItem(key, JSON.stringify(val)); return val; }
      var v = localStorage.getItem(key);
      return v == null ? null : JSON.parse(v);
    } catch (e) { return null; }
  }

  var serverOffset = 0; // różnica zegara tablet <-> PC (Kindle potrafi się rozjechać)
  function now() { return Date.now() + serverOffset; }

  // Dotyk: reakcja na touchend (bez 300 ms opóźnienia) + wizualne "wciśnięcie".
  function onTap(node, fn) {
    var touched = false;
    node.addEventListener('touchstart', function () {
      touched = true;
      node.classList.add('pressed');
    }, false);
    node.addEventListener('touchend', function (e) {
      node.classList.remove('pressed');
      e.preventDefault();
      fn(e);
    }, false);
    node.addEventListener('touchcancel', function () { node.classList.remove('pressed'); }, false);
    node.addEventListener('click', function (e) {
      if (touched) { touched = false; return; }
      fn(e);
    }, false);
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, 2200);
  }

  // ------------------------------------------------------------------ API
  var TOKEN = (function () {
    var m = /[?&]token=([^&#]+)/.exec(location.search);
    if (m) { store('deck.token', decodeURIComponent(m[1])); }
    return store('deck.token') || '';
  })();

  function api(method, path, body, cb) {
    var xhr = new XMLHttpRequest();
    var done = false;
    xhr.open(method, path, true);
    xhr.setRequestHeader('X-Deck-Token', TOKEN);
    if (body) xhr.setRequestHeader('Content-Type', 'application/json');
    var timer = setTimeout(function () { // własny timeout - stare XHR nie mają ontimeout
      if (done) return;
      done = true;
      try { xhr.abort(); } catch (e) {}
      cb && cb({ status: 0, error: 'timeout' }, null);
    }, 7000);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      clearTimeout(timer);
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) cb && cb(null, data);
      else cb && cb({ status: xhr.status, error: (data && data.error) || ('HTTP ' + xhr.status) }, data);
    };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  // ------------------------------------------------------------------ status PC
  var CONFIG = null;
  var connected = false;

  function setStatus(state, text) {
    $('pc-dot').className = 'dot' + (state === 'ok' ? ' ok' : state === 'warn' ? ' warn' : '');
    $('pc-status').textContent = text;
  }

  function ping() {
    var t0 = Date.now();
    api('GET', '/api/ping', null, function (err, d) {
      if (err) {
        connected = false;
        $('pc-ping').textContent = '';
        if (err.status === 401) {
          setStatus('warn', 'Zły token');
          askToken();
        } else {
          setStatus('err', 'PC Offline');
        }
        return;
      }
      var rtt = Date.now() - t0;
      serverOffset = d.now + rtt / 2 - Date.now();
      $('pc-ping').textContent = rtt + ' ms';
      setStatus('ok', 'PC Connected · ' + d.host);
      if (!connected) { connected = true; loadAll(); }
    });
  }

  var asking = false;
  function askToken() {
    if (asking) return;
    asking = true;
    var t = window.prompt('Token z config.json na PC:', TOKEN);
    asking = false;
    if (t != null && t !== TOKEN) { TOKEN = t; store('deck.token', t); ping(); }
  }

  function loadAll() {
    loadConfig();
    loadTodos();
    loadWeather();
    loadEvents();
  }

  // ------------------------------------------------------------------ Stream Deck
  function loadConfig() {
    api('GET', '/api/config', null, function (err, d) {
      if (err) return;
      CONFIG = d;
      renderDeck(d.buttons || []);
      applyPomoConfig(d.pomodoro || {});
    });
  }

  function renderDeck(buttons) {
    var grid = $('deck-grid');
    grid.innerHTML = '';
    for (var i = 0; i < 12; i++) {
      var wrap = el('div', 'key-wrap');
      var b = buttons[i];
      if (!b) {
        wrap.appendChild(el('div', 'key key-empty'));
      } else {
        wrap.appendChild(makeKey(b));
      }
      grid.appendChild(wrap);
    }
  }

  function makeKey(b) {
    var color = b.color || '#00f0ff';
    var k = el('div', 'key');
    k.style.borderColor = color;
    k.style.color = color;
    k.style.boxShadow = '0 0 10px ' + hexA(color, 0.35) + ', inset 0 0 14px ' + hexA(color, 0.12);
    var icon = el('div', 'key-icon', b.icon || '•');
    icon.style.textShadow = '0 0 12px ' + hexA(color, 0.8);
    k.appendChild(icon);
    k.appendChild(el('div', 'key-label', b.label || b.id));
    if (b.sub) k.appendChild(el('div', 'key-sub', b.sub));
    onTap(k, function () { fireKey(k, b); });
    return k;
  }

  function fireKey(k, b) {
    if (k.classList.contains('busy')) return;
    k.classList.add('busy');
    triggerAction(b.id, function (err) {
      k.classList.remove('busy');
      k.classList.add(err ? 'fail' : 'ok');
      setTimeout(function () { k.classList.remove('ok'); k.classList.remove('fail'); }, err ? 900 : 350);
    });
  }

  function triggerAction(id, cb) {
    api('POST', '/api/action/' + encodeURIComponent(id), {}, function (err) {
      if (err) toast((err.status === 0 ? 'Brak połączenia z PC' : err.error), true);
      cb && cb(err);
    });
  }

  function hexA(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return 'rgba(0,240,255,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  // ------------------------------------------------------------------ To-Do
  function loadTodos() {
    api('GET', '/api/todos', null, function (err, d) { if (!err) renderTodos(d.items); });
  }

  function renderTodos(items) {
    var list = $('todo-list');
    list.innerHTML = '';
    var open = 0;
    // niezrobione na górze, zrobione na dole
    var sorted = items.slice().sort(function (a, b) { return (a.done - b.done) || (a.created - b.created); });
    for (var i = 0; i < sorted.length; i++) {
      if (!sorted[i].done) open++;
      list.appendChild(todoItem(sorted[i]));
    }
    if (!items.length) list.appendChild(el('li', 'empty', 'Pusto. Dodaj pierwsze zadanie ↑'));
    $('todo-count').textContent = open + ' / ' + items.length;
  }

  function todoItem(it) {
    var li = el('li', 'todo-item' + (it.done ? ' done' : ''));
    var chk = el('span', 'todo-check', it.done ? '✓' : '');
    var txt = el('span', 'todo-text', it.text);
    var del = el('button', 'todo-del', '✕');
    li.appendChild(chk); li.appendChild(txt); li.appendChild(del);
    function toggle() {
      li.classList.toggle('done'); // od razu, nie czekamy na serwer
      api('POST', '/api/todos/' + it.id + '/toggle', {}, todoCb);
    }
    chk.addEventListener('click', toggle, false);
    txt.addEventListener('click', toggle, false);
    del.addEventListener('click', function () {
      api('DELETE', '/api/todos/' + it.id, null, todoCb);
    }, false);
    return li;
  }

  function todoCb(err, d) {
    if (err) { toast('Nie zapisano: ' + err.error, true); loadTodos(); return; }
    renderTodos(d.items);
  }

  $('todo-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('todo-input');
    var text = input.value.replace(/^\s+|\s+$/g, '');
    if (!text) return;
    input.value = '';
    input.blur(); // chowa klawiaturę Fire OS
    api('POST', '/api/todos', { text: text }, todoCb);
  }, false);

  $('todo-clear').addEventListener('click', function () {
    api('POST', '/api/todos/clear_done', {}, todoCb);
  }, false);

  // ------------------------------------------------------------------ Pomodoro
  var PCFG = { work: 25, short_break: 5, long_break: 15, long_every: 4, auto_focus: true };
  var MODE_NAMES = { work: 'PRACA', short: 'PRZERWA', long: 'DŁUGA PRZERWA' };
  var P = store('deck.pomo') || { mode: 'work', running: false, endAt: 0, remaining: 25 * 60000, total: 25 * 60000, cycles: 0 };

  function applyPomoConfig(c) {
    for (var k in c) if (c.hasOwnProperty(k)) PCFG[k] = c[k];
    if (!P.running && P.remaining === P.total) setMode(P.mode, true); // odśwież długość, jeśli nieruszony
    renderPomo();
  }

  function durOf(mode) {
    var m = mode === 'work' ? PCFG.work : mode === 'short' ? PCFG.short_break : PCFG.long_break;
    return Math.round(m * 60000);
  }

  function savePomo() { store('deck.pomo', P); }

  function setMode(mode, quiet) {
    P.mode = mode;
    P.total = P.remaining = durOf(mode);
    P.running = false;
    savePomo();
    if (!quiet) renderPomo();
  }

  function startPomo() {
    var fresh = P.remaining === P.total;
    P.endAt = now() + P.remaining;
    P.running = true;
    savePomo();
    if (fresh) {
      var hook = P.mode === 'work' ? PCFG.on_work_start : PCFG.on_break_start;
      if (hook) triggerAction(hook);
    }
    if (PCFG.auto_focus) showFocus(true);
    renderPomo();
  }

  function pausePomo() {
    P.remaining = Math.max(0, P.endAt - now());
    P.running = false;
    savePomo();
    renderPomo();
  }

  function finishPomo(silent) {
    var wasWork = P.mode === 'work';
    var next = 'work';
    if (wasWork) {
      P.cycles++;
      next = (P.cycles % (PCFG.long_every || 4) === 0) ? 'long' : 'short';
    }
    setMode(next);
    if (!silent) {
      beep(wasWork ? 3 : 2);
      $('focus').classList.add('flash');
      setTimeout(function () { $('focus').classList.remove('flash'); }, 3200);
      toast(wasWork ? 'Koniec sesji! Czas na przerwę.' : 'Przerwa skończona - wracamy do roboty.');
    }
    if (wasWork) startPomo(); // przerwa startuje sama, praca czeka na Twój ruch
  }

  function fmt(ms) {
    var s = Math.ceil(ms / 1000);
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function renderPomo() {
    if (P.running) P.remaining = Math.max(0, P.endAt - now());
    var isBreak = P.mode !== 'work';
    var t = fmt(P.remaining);
    var pct = P.total ? (100 - P.remaining / P.total * 100) : 0;

    $('pomo-time').textContent = t;
    $('pomo-time').className = 'pomo-time' + (isBreak ? ' break' : '');
    $('pomo-bar').style.width = pct + '%';
    $('pomo-bar').className = 'progress-bar' + (isBreak ? ' break' : '');
    $('pomo-cycles').textContent = '#' + P.cycles;
    $('pomo-start').textContent = P.running ? 'PAUZA' : (P.remaining < P.total ? 'WZNÓW' : 'START');

    var chips = document.querySelectorAll('.pomo-modes .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = 'chip' + (chips[i].getAttribute('data-mode') === P.mode ? ' active' : '');
    }

    $('focus-mode').textContent = MODE_NAMES[P.mode] + (P.running ? '' : ' · PAUZA');
    $('focus-mode').className = 'focus-mode' + (isBreak ? ' break' : '');
    $('focus-time').textContent = t;
    $('focus-time').className = 'focus-time' + (isBreak ? ' break' : '') + (P.running ? '' : ' paused');
    $('focus-bar').style.width = pct + '%';
    $('focus-bar').className = 'progress-bar' + (isBreak ? ' break' : '');
    $('focus-toggle').textContent = P.running ? 'PAUZA' : 'START';

    var sb = $('sb-pomo');
    var focusOpen = !$('focus').classList.contains('hidden');
    if (P.running && !focusOpen) { sb.textContent = '◷ ' + t; sb.classList.remove('hidden'); }
    else sb.classList.add('hidden');
  }

  function showFocus(on) {
    $('focus').classList[on ? 'remove' : 'add']('hidden');
    renderPomo();
  }

  function togglePomo() { if (P.running) pausePomo(); else startPomo(); }

  onTap($('pomo-start'), togglePomo);
  onTap($('pomo-reset'), function () { setMode(P.mode); });
  onTap($('pomo-focus'), function () { showFocus(true); });
  onTap($('focus-toggle'), togglePomo);
  onTap($('focus-skip'), function () { finishPomo(true); });
  onTap($('focus-exit'), function () { showFocus(false); });
  onTap($('sb-pomo'), function () { showFocus(true); });
  (function () {
    var chips = document.querySelectorAll('.pomo-modes .chip');
    for (var i = 0; i < chips.length; i++) {
      (function (c) { onTap(c, function () { setMode(c.getAttribute('data-mode')); }); })(chips[i]);
    }
  })();

  var audioCtx = null;
  function beep(times) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      for (var i = 0; i < times; i++) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        g.gain.value = 0.15;
        o.connect(g); g.connect(audioCtx.destination);
        var t0 = audioCtx.currentTime + i * 0.35;
        o.start(t0); o.stop(t0 + 0.2);
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ zegar
  var DAYS = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
  var MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca',
                'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

  function tickClock() {
    var d = new Date(now());
    var c = $('clock');
    c.innerHTML = '';
    c.appendChild(document.createTextNode(pad(d.getHours()) + ':' + pad(d.getMinutes())));
    c.appendChild(el('span', 'sec', ':' + pad(d.getSeconds())));
    $('date').textContent = DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    $('focus-clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ------------------------------------------------------------------ pogoda
  function loadWeather() {
    api('GET', '/api/weather', null, function (err, w) {
      if (err) { $('w-desc').textContent = 'pogoda niedostępna'; return; }
      $('w-icon').textContent = w.icon;
      $('w-temp').textContent = w.temp + '°';
      $('w-desc').textContent = w.desc;
      $('w-extra').textContent = 'odczuwalna ' + w.feels + '° · wiatr ' + w.wind + ' km/h · ' +
        w.humidity + '%' + (CONFIG && CONFIG.location ? ' · ' + CONFIG.location : '');
      var box = $('w-days');
      box.innerHTML = '';
      var labels = ['Dziś', 'Jutro'];
      for (var i = 0; i < w.days.length; i++) {
        var dd = w.days[i];
        var p = dd.date.split('-');
        var name = labels[i] || DAYS[new Date(+p[0], +p[1] - 1, +p[2]).getDay()].slice(0, 3);
        var cell = el('div', 'w-day');
        cell.appendChild(document.createTextNode(name));
        cell.appendChild(el('b', null, dd.icon + ' ' + dd.tmax + '°'));
        cell.appendChild(document.createTextNode(dd.tmin + '° · ☂' + (dd.rain == null ? '-' : dd.rain) + '%'));
        box.appendChild(cell);
      }
    });
  }

  // ------------------------------------------------------------------ kalendarz
  var EVENTS = [];

  function parseLocal(s) { // "2026-10-07T14:30:00" -> Date lokalny (bez zgadywania strefy przez stary silnik)
    var p = s.split(/[-T:]/);
    return new Date(+p[0], +p[1] - 1, +p[2], +(p[3] || 0), +(p[4] || 0), +(p[5] || 0));
  }

  function loadEvents() {
    api('GET', '/api/events', null, function (err, d) {
      if (err) { $('ev-status').textContent = 'błąd'; return; }
      EVENTS = d.items || [];
      $('ev-status').textContent = d.configured ? (d.stale ? 'offline' : '') : 'brak ICS w config';
      renderEvents();
    });
  }

  function dayLabel(d) {
    var t = new Date(now()); t.setHours(0, 0, 0, 0);
    var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0);
    var diff = Math.round((x - t) / 86400000);
    if (diff <= 0) return 'DZIŚ';
    if (diff === 1) return 'JUTRO';
    return (DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()]).toUpperCase();
  }

  function renderEvents() {
    var list = $('ev-list');
    list.innerHTML = '';
    if (!EVENTS.length) { list.appendChild(el('li', 'empty', 'Brak nadchodzących wydarzeń')); return; }
    var t = now();
    var lastGroup = '';
    for (var i = 0; i < EVENTS.length; i++) {
      var ev = EVENTS[i];
      var s = parseLocal(ev.start), e = parseLocal(ev.end);
      if (e.getTime() < t) continue;
      var g = dayLabel(s);
      if (g !== lastGroup) { list.appendChild(el('li', 'ev-group', g)); lastGroup = g; }
      var cls = 'ev';
      if (!ev.all_day) {
        if (s.getTime() <= t) cls += ' now';
        else if (s.getTime() - t < 15 * 60000) cls += ' soon';
      }
      var li = el('li', cls);
      var when = ev.all_day ? 'cały dzień'
        : pad(s.getHours()) + ':' + pad(s.getMinutes()) + ' – ' + pad(e.getHours()) + ':' + pad(e.getMinutes());
      if (cls.indexOf('now') > -1) when += ' · TRWA';
      else if (cls.indexOf('soon') > -1) when += ' · za ' + Math.ceil((s.getTime() - t) / 60000) + ' min';
      li.appendChild(el('div', 'ev-time', when));
      li.appendChild(el('div', 'ev-title', ev.title));
      if (ev.has_link) li.appendChild(joinBtn(ev));
      list.appendChild(li);
    }
  }

  function joinBtn(ev) {
    var b = el('button', 'ev-join', 'DOŁĄCZ');
    onTap(b, function () {
      api('POST', '/api/events/' + ev.id + '/join', {}, function (err) {
        toast(err ? 'Nie udało się otworzyć spotkania' : 'Otwieram spotkanie na PC…', !!err);
      });
    });
    return b;
  }

  // ------------------------------------------------------------------ bateria
  function readBattery() {
    var show = function (level, charging) {
      if (level == null || isNaN(level)) { $('battery').classList.add('hidden'); return; }
      $('battery').classList.remove('hidden');
      var f = $('bat-fill');
      f.style.width = Math.max(2, Math.round(level / 100 * 20)) + 'px';
      f.className = 'bat-fill' + (charging ? ' charging' : level <= 20 ? ' low' : '');
      $('bat-text').textContent = level + '%' + (charging ? ' ⚡' : '');
    };
    try {
      if (window.fully && fully.getBatteryLevel) { // Fully Kiosk Browser JS API
        show(parseInt(fully.getBatteryLevel(), 10), fully.isPlugged && fully.isPlugged());
        return;
      }
      if (navigator.getBattery) {
        navigator.getBattery().then(function (b) { show(Math.round(b.level * 100), b.charging); });
        return;
      }
    } catch (e) {}
    show(null);
  }

  // ------------------------------------------------------------------ pasek
  onTap($('btn-fs'), function () {
    var d = document.documentElement;
    var req = d.requestFullscreen || d.webkitRequestFullscreen || d.webkitRequestFullScreen || d.mozRequestFullScreen;
    if (req) req.call(d);
  });
  onTap($('btn-reload'), function () { location.reload(); });

  // ------------------------------------------------------------------ pętle
  tickClock();
  renderPomo();
  readBattery();
  ping();

  setInterval(function () {
    tickClock();
    if (P.running) {
      renderPomo();
      if (P.remaining <= 0) finishPomo(false);
    }
  }, 500);
  setInterval(ping, 5000);
  setInterval(readBattery, 60000);
  setInterval(function () { if (connected) loadWeather(); }, 10 * 60000);
  setInterval(function () { if (connected) loadEvents(); }, 2 * 60000);
  setInterval(function () { if (connected) loadTodos(); }, 30000); // gdy dodasz zadanie z PC
  setInterval(renderEvents, 30000);                                // "za X min" / TRWA
})();
