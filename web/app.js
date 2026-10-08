/*
 * Kindle Deck - klient na tablet.
 * Celowo czysty ES5 (var, function, XMLHttpRequest, bez Promise/fetch/arrow),
 * żeby ruszył na starym Silk / WebView z Fire OS bez transpilacji.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ ikony (SVG inline, styl liniowy 24x24)
  var ICONS = {
    // interfejs
    logo: '<circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z" fill="currentColor"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    reset: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
    // kafelki
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/>',
    'mic-off': '<path d="M2 2l20 20M18.89 13.23A7 7 0 0 0 19 11v-1M5 10v1a7 7 0 0 0 12 4.9M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v2a3 3 0 0 0 5.12 2.12M12 18v4M8 22h8"/>',
    'volume-x': '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
    volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    playpause: '<path d="M3 5l8 7-8 7z" fill="currentColor"/><path d="M15 5v14M20 5v14"/>',
    next: '<path d="M5 4l10 8-10 8z" fill="currentColor"/><path d="M19 5v14"/>',
    prev: '<path d="M19 20L9 12l10-8z" fill="currentColor"/><path d="M5 19V5"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    camera: '<path d="M22 8l-6 4 6 4z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
    stream: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>',
    gamepad: '<rect x="2" y="6" width="20" height="12" rx="4"/><path d="M6 12h4M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/>',
    bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
    terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    home: '<path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>',
    // pogoda (kolorowe: słońce żółte, chmura jasna, opad niebieski)
    sun: '<g stroke="#FFC845"><circle cx="12" cy="12" r="4" fill="#FFC845"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g>',
    moon: '<path stroke="#C9D3E6" fill="#C9D3E6" fill-opacity="0.15" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    cloud: '<path stroke="#E6ECF5" fill="#E6ECF5" fill-opacity="0.12" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>',
    'cloud-sun': '<path stroke="#FFC845" d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.95 12.65a4 4 0 0 0-5.93-4.61"/><path stroke="#E6ECF5" fill="#E6ECF5" fill-opacity="0.12" d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6z"/>',
    rain: '<path stroke="#E6ECF5" d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path stroke="#5AA9FF" d="M16 14v6M8 14v6M12 16v6"/>',
    snow: '<path stroke="#E6ECF5" d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path stroke="#BFE3FF" d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>',
    storm: '<path stroke="#E6ECF5" d="M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97"/><path stroke="#FFC845" d="M13 12l-3 5h4l-3 5"/>',
    fog: '<path stroke="#E6ECF5" d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path stroke="#9AA8C2" d="M16 17H7M17 21H9"/>'
  };

  function svg(name, stroke) {
    var body = ICONS[name] || ICONS.settings;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (stroke || 2) +
      '" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

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
    toastTimer = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, 2500);
  }

  // statyczne ikony z HTML (data-icon="...")
  (function () {
    var nodes = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) nodes[i].innerHTML = svg(nodes[i].getAttribute('data-icon'));
  })();

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
    $('pc-state').className = 'pc-state' + (state ? ' ' + state : '');
    $('pc-status').textContent = text;
  }

  function ping() {
    var t0 = Date.now();
    api('GET', '/api/ping', null, function (err, d) {
      if (err) {
        connected = false;
        $('pc-ping').textContent = '';
        if (err.status === 401 || err.status === 403) {
          setStatus('warn', 'BRAK DOSTĘPU (config)');
        } else {
          setStatus('', 'PC OFFLINE');
        }
        return;
      }
      var rtt = Date.now() - t0;
      serverOffset = d.now + rtt / 2 - Date.now();
      $('pc-ping').textContent = rtt + ' ms';
      setStatus('ok', 'PC CONNECTED (WI-FI)');
      if (!connected) { connected = true; loadAll(); }
    });
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
      $('w-loc').textContent = d.location || '';
      renderDeck(d.buttons || []);
      applyPomoConfig(d.pomodoro || {});
    });
  }

  // 1-4 przyciski -> 2x2, 5-6 -> 2x3, 7-9 -> 3x3, 10-12 -> 3x4
  function gridFor(n) {
    if (n <= 4) return [2, 2];
    if (n <= 6) return [2, 3];
    if (n <= 9) return [3, 3];
    return [3, 4];
  }

  function renderDeck(buttons) {
    var grid = $('deck-grid');
    var g = gridFor(buttons.length);
    var slots = g[0] * g[1];
    grid.innerHTML = '';
    grid.className = 'deck-grid cols-' + g[0] + ' rows-' + g[1];
    for (var i = 0; i < slots; i++) {
      var wrap = el('div', 'key-wrap');
      wrap.style.width = (100 / g[0]) + '%';
      wrap.style.height = (100 / g[1]) + '%';
      wrap.appendChild(buttons[i] ? makeKey(buttons[i]) : el('div', 'key key-empty'));
      grid.appendChild(wrap);
    }
  }

  function makeKey(b) {
    var k = el('div', 'key');
    if (b.color) k.style.backgroundColor = b.color;
    var icon = el('div', 'key-icon');
    var name = b.icon || 'settings';
    if (name.indexOf('.') > -1) {
      // plik z web/icons/ (np. "chrome.svg", "discord.png") - logotypy aplikacji na ciemnym kafelku
      k.classList.add('key-logo');
      var img = el('img');
      img.src = 'icons/' + name;
      icon.appendChild(img);
    } else {
      icon.innerHTML = svg(name, 1.8);
    }
    if (b.icon_color) icon.style.color = b.icon_color;
    k.appendChild(icon);
    k.appendChild(el('div', 'key-label', b.label || b.id));
    onTap(k, function () { fireKey(k, b); });
    return k;
  }

  function fireKey(k, b) {
    if (k.classList.contains('busy')) return;
    k.classList.add('busy');
    triggerAction(b.id, function (err) {
      k.classList.remove('busy');
      k.classList.add(err ? 'fail' : 'ok');
      setTimeout(function () { k.classList.remove('ok'); k.classList.remove('fail'); }, err ? 900 : 250);
    });
  }

  function triggerAction(id, cb) {
    api('POST', '/api/action/' + encodeURIComponent(id), {}, function (err) {
      if (err) toast((err.status === 0 ? 'Brak połączenia z PC' : err.error), true);
      cb && cb(err);
    });
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
    if (!items.length) list.appendChild(el('li', 'empty', 'Brak zadań.'));
    $('todo-count').textContent = items.length ? (open + ' otwarte') : '';
  }

  function todoItem(it) {
    var li = el('li', 'todo-item' + (it.done ? ' done' : ''));
    var chk = el('span', 'todo-check');
    chk.innerHTML = it.done ? svg('check', 3) : '';
    var txt = el('span', 'todo-text', it.text);
    var del = el('button', 'todo-del');
    del.innerHTML = svg('x');
    li.appendChild(chk); li.appendChild(txt); li.appendChild(del);
    function toggle() {
      var done = !li.classList.contains('done');
      li.classList.toggle('done'); // od razu, nie czekamy na serwer
      chk.innerHTML = done ? svg('check', 3) : '';
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
      toast(wasWork ? 'Sesja zakończona. Przerwa.' : 'Koniec przerwy.');
    }
    if (wasWork) startPomo(); // przerwa startuje sama, praca czeka na Twój ruch
  }

  function fmt(ms) {
    var s = Math.ceil(ms / 1000);
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  var lastPlayState = null;
  function renderPomo() {
    if (P.running) P.remaining = Math.max(0, P.endAt - now());
    var isBreak = P.mode !== 'work';
    var t = fmt(P.remaining);
    var pct = P.total ? (100 - P.remaining / P.total * 100) : 0;
    var barCls = 'progress-bar' + (isBreak ? ' break' : '');

    $('pomo-time').textContent = t;
    $('pomo-bar').style.width = pct + '%';
    $('pomo-bar').className = barCls;
    $('pomo-cycles').textContent = P.cycles ? ('Sesje: ' + P.cycles) : '';
    if (lastPlayState !== P.running) { // nie podmieniaj SVG co 0,5 s
      lastPlayState = P.running;
      $('pomo-start').innerHTML = svg(P.running ? 'pause' : 'play');
    }

    var segs = document.querySelectorAll('.seg-btn');
    for (var i = 0; i < segs.length; i++) {
      segs[i].className = 'seg-btn' + (segs[i].getAttribute('data-mode') === P.mode ? ' active' : '');
    }

    $('focus-mode').textContent = MODE_NAMES[P.mode] + (P.running ? '' : ' · PAUZA');
    $('focus-mode').className = 'focus-mode' + (isBreak ? ' break' : '');
    $('focus-time').textContent = t;
    $('focus-time').className = 'focus-time' + (P.running ? '' : ' paused');
    $('focus-bar').style.width = pct + '%';
    $('focus-bar').className = barCls;
    $('focus-toggle').textContent = P.running ? 'Pauza' : 'Start';

    var sb = $('sb-pomo');
    var focusOpen = !$('focus').classList.contains('hidden');
    if (P.running && !focusOpen) { sb.textContent = (isBreak ? 'Przerwa ' : 'Praca ') + t; sb.classList.remove('hidden'); }
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
    var segs = document.querySelectorAll('.seg-btn');
    for (var i = 0; i < segs.length; i++) {
      (function (c) { onTap(c, function () { setMode(c.getAttribute('data-mode')); }); })(segs[i]);
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
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.value = 0.2;
        o.connect(g); g.connect(audioCtx.destination);
        var t0 = audioCtx.currentTime + i * 0.35;
        o.start(t0); o.stop(t0 + 0.2);
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ zegar
  var DAYS = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
  var DAYS_SHORT = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb'];
  var MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca',
                'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

  function tickClock() {
    var d = new Date(now());
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    $('sb-clock').textContent = hm;
    $('focus-clock').textContent = hm;
    $('date').textContent = DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  // ------------------------------------------------------------------ pogoda
  function loadWeather() {
    api('GET', '/api/weather', null, function (err, w) {
      if (err) { $('w-desc').textContent = 'Pogoda niedostępna'; return; }
      $('w-icon').innerHTML = svg(w.icon, 1.6);
      $('w-temp').textContent = w.temp + '°';
      $('w-desc').textContent = w.desc;
      $('w-range').textContent = w.days.length ? (w.days[0].tmax + '° / ' + w.days[0].tmin + '°') : '';
      $('w-loc').textContent = CONFIG && CONFIG.location ? CONFIG.location : '';
      $('w-feels').textContent = w.feels + '°';
      $('w-wind').textContent = w.wind + ' km/h';
      $('w-hum').textContent = w.humidity + '%';
      var box = $('w-days');
      box.innerHTML = '';
      for (var i = 1; i < w.days.length && i <= 3; i++) { // dziś jest w nagłówku
        var dd = w.days[i];
        var p = dd.date.split('-');
        var cell = el('div', 'w-day');
        cell.appendChild(el('span', 'w-day-name', i === 1 ? 'Jutro' : DAYS_SHORT[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]));
        var ic = el('span', 'w-day-icon');
        ic.innerHTML = svg(dd.icon);
        cell.appendChild(ic);
        cell.appendChild(el('b', null, dd.tmax + '°'));
        cell.appendChild(el('span', 'w-day-min', dd.tmin + '°'));
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
      if (err) { $('ev-status').textContent = 'błąd pobierania'; return; }
      EVENTS = d.items || [];
      $('ev-status').textContent = d.configured ? (d.stale ? 'offline' : '') : 'brak adresu ICS';
      renderEvents();
    });
  }

  function dayLabel(d) {
    var t = new Date(now()); t.setHours(0, 0, 0, 0);
    var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0);
    var diff = Math.round((x - t) / 86400000);
    if (diff <= 0) return 'Dziś';
    if (diff === 1) return 'Jutro';
    return DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  function renderEvents() {
    var list = $('ev-list');
    var scroll = list.scrollTop;
    list.innerHTML = '';
    var t = now();
    var lastGroup = '';
    var shown = 0;
    for (var i = 0; i < EVENTS.length; i++) {
      var ev = EVENTS[i];
      var s = parseLocal(ev.start), e = parseLocal(ev.end);
      if (e.getTime() < t) continue;
      shown++;
      var g = dayLabel(s);
      if (g !== lastGroup) { list.appendChild(el('li', 'ev-group', g)); lastGroup = g; }
      var state = '';
      if (!ev.all_day) {
        if (s.getTime() <= t) state = 'now';
        else if (s.getTime() - t < 15 * 60000) state = 'soon';
      }
      var li = el('li', 'ev' + (state ? ' ' + state : ''));
      var body = el('div', 'ev-body');
      var time = el('div', 'ev-time');
      time.appendChild(el('b', null, ev.all_day ? 'Cały dzień'
        : pad(s.getHours()) + ':' + pad(s.getMinutes())));
      if (!ev.all_day) time.appendChild(document.createTextNode(' – ' + pad(e.getHours()) + ':' + pad(e.getMinutes())));
      if (state === 'now') time.appendChild(el('span', 'ev-badge', 'trwa'));
      if (state === 'soon') time.appendChild(el('span', 'ev-badge', 'za ' + Math.ceil((s.getTime() - t) / 60000) + ' min'));
      body.appendChild(time);
      body.appendChild(el('div', 'ev-title', ev.title));
      li.appendChild(body);
      if (ev.has_link) li.appendChild(joinBtn(ev));
      list.appendChild(li);
    }
    if (!shown) list.appendChild(el('li', 'empty', 'Brak nadchodzących wydarzeń.'));
    list.scrollTop = scroll;
  }

  function joinBtn(ev) {
    var b = el('button', 'ev-join', 'DOŁĄCZ');
    onTap(b, function () {
      api('POST', '/api/events/' + ev.id + '/join', {}, function (err) {
        toast(err ? 'Nie udało się otworzyć spotkania' : 'Otwieram spotkanie na PC', !!err);
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
      f.style.width = Math.max(1, Math.round(level / 100 * 18)) + 'px';
      f.className = 'bat-fill' + (charging ? ' charging' : level <= 20 ? ' low' : '');
      $('bat-text').textContent = level + '%';
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
  setInterval(renderEvents, 30000);                                // "za X min" / trwa
})();
