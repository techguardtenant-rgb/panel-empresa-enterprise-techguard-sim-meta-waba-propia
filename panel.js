/**
 * Panel de empresa P2L — versión estática para GitHub Pages.
 * Misma UI que el panel de refactorii, pero autentica con companyId + companyKey
 * contra /public/portal/* en lugar de Google.
 */
(function () {
  'use strict';

  var API = 'https://www.refactorii.com/p2l-tenant/api/p2l-techguard-whatsapp-bot';
  var TOKEN_PREFIX = 'tg_portal_token_';
  var SOCKET_ORIGIN = 'https://www.refactorii.com';
  var SOCKET_PATH = '/p2l-tenant/socket.io';
  var CHAT_LIVE_MS = 3 * 60 * 1000;

  var state = {
    companyId: '',
    token: '',
    company: null,
    connection: null,
    busy: false,
    conversations: [],
    selectedWaFrom: '',
    chatSocketOk: false,
    chatStickToBottom: true,
    flashingWaFrom: '',
    panelPane: 'mcp'
  };
  var chatPollTimer = null;
  var chatFlashTimer = null;
  var chatLiveTimer = null;
  var aiUsageTimer = null;
  var aiUsageFetchTimer = null;
  var chatSocket = null;

  /* ── utilidades ──────────────────────────────────────────────────────── */

  function $(sel) {
    return document.querySelector(sel);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatWhen(d) {
    try {
      return new Date(d).toLocaleString('es-CO');
    } catch (_) {
      return String(d || '');
    }
  }

  function formatTokens(n) {
    return Math.max(0, Number(n) || 0).toLocaleString('es-CO');
  }

  function formatUsd(n) {
    var v = Math.max(0, Number(n) || 0);
    if (v === 0) return '$0.00';
    return v >= 0.01 ? '$' + v.toFixed(2) : '$' + v.toFixed(6);
  }

  function formatWhenShort(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      var now = new Date();
      if (dt.toDateString() === now.toDateString()) {
        return dt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      }
      return dt.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
    } catch (_) {
      return String(d);
    }
  }

  function stopChatLive() {
    if (chatPollTimer) {
      clearInterval(chatPollTimer);
      chatPollTimer = null;
    }
    if (chatLiveTimer) {
      clearInterval(chatLiveTimer);
      chatLiveTimer = null;
    }
    if (aiUsageTimer) {
      clearInterval(aiUsageTimer);
      aiUsageTimer = null;
    }
    if (aiUsageFetchTimer) {
      clearTimeout(aiUsageFetchTimer);
      aiUsageFetchTimer = null;
    }
    if (chatFlashTimer) {
      clearTimeout(chatFlashTimer);
      chatFlashTimer = null;
    }
    if (chatSocket) {
      try {
        chatSocket.disconnect();
      } catch (_) {}
      chatSocket = null;
    }
    state.chatSocketOk = false;
    state.flashingWaFrom = '';
  }

  function isThreadLive(t) {
    if (!t || !t.lastMessageAt) return false;
    var at = new Date(t.lastMessageAt).getTime();
    if (!isFinite(at)) return false;
    return Date.now() - at < CHAT_LIVE_MS;
  }

  function updateLiveClassesOnly() {
    var list = $('#tg-chat-list');
    if (!list) return;
    list.querySelectorAll('[data-wa]').forEach(function (btn) {
      var wa = btn.getAttribute('data-wa') || '';
      var t = state.conversations.find(function (row) {
        return row.waFrom === wa;
      });
      var live = isThreadLive(t);
      btn.classList.toggle('tg-chats__item--live', live);
      btn.classList.toggle('tg-chats__item--live-hit', live && wa === state.flashingWaFrom);
      btn.classList.toggle('tg-chats__item--flash', wa === state.flashingWaFrom);
    });
  }

  function flashThread(waFrom) {
    state.flashingWaFrom = String(waFrom || '');
    updateLiveClassesOnly();
    if (chatFlashTimer) clearTimeout(chatFlashTimer);
    chatFlashTimer = setTimeout(function () {
      state.flashingWaFrom = '';
      updateLiveClassesOnly();
    }, 1600);
  }

  function setLiveBadge() {
    var elLive = $('#tg-chat-live');
    if (!elLive) return;
    elLive.textContent = state.chatSocketOk ? '● En vivo (socket)' : '○ Polling';
    elLive.className = 'tg-chats__live' + (state.chatSocketOk ? ' tg-chats__live--on' : '');
  }

  function isChatNearBottom() {
    var box = $('#tg-chat-msgs');
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 56;
  }

  function scrollChatToEnd() {
    var box = $('#tg-chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bindChatScroll() {
    var box = $('#tg-chat-msgs');
    if (!box || box.getAttribute('data-tg-scroll') === '1') return;
    box.setAttribute('data-tg-scroll', '1');
    box.addEventListener('scroll', function () {
      state.chatStickToBottom = isChatNearBottom();
    });
  }

  function renderChatPane(opts) {
    opts = opts || {};
    var forceBottom = opts.forceBottom === true;
    var stick = forceBottom || state.chatStickToBottom !== false;
    var prevBox = $('#tg-chat-msgs');
    var prevTop = prevBox ? prevBox.scrollTop : 0;
    var list = $('#tg-chat-list');
    var thread = $('#tg-chat-thread');
    var count = $('#tg-chat-count');
    if (!list || !thread) return;
    if (count) {
      count.textContent =
        state.conversations.length +
        ' hilo' +
        (state.conversations.length === 1 ? '' : 's');
    }
    setLiveBadge();

    if (!state.conversations.length) {
      list.innerHTML = '<p class="tg-chats__empty">Esperando mensajes de usuarios…</p>';
      thread.innerHTML =
        '<p class="tg-chats__empty">Elige un hilo o espera el primer mensaje.</p>';
      return;
    }

    var selected = state.selectedWaFrom;
    if (!selected || !state.conversations.some(function (t) { return t.waFrom === selected; })) {
      selected = state.conversations[0].waFrom;
      state.selectedWaFrom = selected;
      stick = true;
    }

    list.innerHTML = state.conversations
      .map(function (t) {
        var active = t.waFrom === selected ? ' tg-chats__item--active' : '';
        var live = isThreadLive(t) ? ' tg-chats__item--live' : '';
        var hit =
          t.waFrom === state.flashingWaFrom
            ? ' tg-chats__item--flash tg-chats__item--live-hit'
            : '';
        return (
          '<button type="button" class="tg-chats__item' +
          active +
          live +
          hit +
          '" data-wa="' +
          esc(t.waFrom) +
          '">' +
          '<span class="tg-chats__phone">' +
          esc(t.label || ('+' + t.waFrom)) +
          '</span>' +
          '<span class="tg-chats__time">' +
          esc(formatWhenShort(t.lastMessageAt)) +
          '</span>' +
          '<span class="tg-chats__preview">' +
          esc(t.preview || '—') +
          '</span></button>'
        );
      })
      .join('');

    list.querySelectorAll('[data-wa]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selectedWaFrom = btn.getAttribute('data-wa') || '';
        state.chatStickToBottom = true;
        renderChatPane({ forceBottom: true });
      });
    });

    var active = state.conversations.find(function (t) {
      return t.waFrom === selected;
    });
    if (!active) {
      thread.innerHTML = '<p class="tg-chats__empty">Sin hilo seleccionado.</p>';
      return;
    }
    var msgs = (active.messages || [])
      .map(function (m) {
        var cls =
          m.role === 'user' ? 'tg-chats__bubble--user' : 'tg-chats__bubble--bot';
        return (
          '<div class="tg-chats__bubble ' +
          cls +
          '">' +
          '<span class="tg-chats__bubble-role">' +
          (m.role === 'user' ? 'Usuario' : 'Bot') +
          '</span>' +
          '<p>' +
          esc(m.content) +
          '</p>' +
          (m.at ? '<time>' + esc(formatWhen(m.at)) + '</time>' : '') +
          '</div>'
        );
      })
      .join('');
    thread.innerHTML =
      '<header class="tg-chats__thread-head"><strong>' +
      esc(active.label || ('+' + active.waFrom)) +
      '</strong><span class="tg-muted">' +
      esc(String(active.messageCount || 0)) +
      ' msgs</span></header>' +
      '<div class="tg-chats__msgs" id="tg-chat-msgs">' +
      (msgs || '<p class="tg-chats__empty">Sin mensajes aún.</p>') +
      '</div>';
    bindChatScroll();
    var box = $('#tg-chat-msgs');
    if (!box) return;
    if (stick) {
      box.scrollTop = box.scrollHeight;
      state.chatStickToBottom = true;
    } else {
      box.scrollTop = prevTop;
    }
  }

  function conversationsSig(rows) {
    return (rows || [])
      .map(function (t) {
        return t.waFrom + ':' + (t.lastMessageAt || '') + ':' + (t.messageCount || 0);
      })
      .join('|');
  }

  function applyConversations(rows, flashFirst) {
    var prev = conversationsSig(state.conversations);
    var next = conversationsSig(rows);
    if (prev === next) {
      setLiveBadge();
      updateLiveClassesOnly();
      var count = $('#tg-chat-count');
      if (count) {
        count.textContent =
          state.conversations.length +
          ' hilo' +
          (state.conversations.length === 1 ? '' : 's');
      }
      return;
    }
    var prevByFrom = {};
    state.conversations.forEach(function (t) {
      prevByFrom[t.waFrom] = t.lastMessageAt || '';
    });
    var changedFrom = [];
    (rows || []).forEach(function (row) {
      var prevAt = prevByFrom[row.waFrom];
      if (prevAt === undefined || prevAt !== (row.lastMessageAt || '')) {
        changedFrom.push(row.waFrom);
      }
    });
    state.chatStickToBottom = isChatNearBottom();
    state.conversations = rows || [];
    renderChatPane({ forceBottom: state.chatStickToBottom });
    if (flashFirst && changedFrom[0]) flashThread(changedFrom[0]);
    else if (flashFirst && state.conversations[0]) flashThread(state.conversations[0].waFrom);
    scheduleAiUsageRefresh();
  }

  function listButtonFor(waFrom) {
    return document.querySelector('#tg-chat-list [data-wa="' + waFrom + '"]');
  }

  function upsertConversation(thread) {
    if (!thread || !thread.waFrom) return;
    var stick = isChatNearBottom();
    var idx = state.conversations.findIndex(function (t) {
      return t.waFrom === thread.waFrom;
    });
    var prev = idx >= 0 ? state.conversations[idx] : null;
    var changed =
      !prev ||
      prev.lastMessageAt !== thread.lastMessageAt ||
      prev.messageCount !== thread.messageCount;
    if (idx >= 0) state.conversations[idx] = thread;
    else state.conversations.unshift(thread);
    state.conversations.sort(function (a, b) {
      return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
    });
    if (!state.selectedWaFrom) state.selectedWaFrom = thread.waFrom;
    state.chatStickToBottom = stick;
    renderChatPane({ forceBottom: stick });
    if (changed) flashThread(thread.waFrom);
  }

  function pollConversations() {
    if (!state.token) return;
    api('/public/portal/conversations?limit=40')
      .then(function (out) {
        applyConversations(out.conversations || [], true);
      })
      .catch(function () {});
  }

  function loadSocketIo(cb) {
    if (typeof io === 'function') return cb(null);
    var s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = function () {
      cb(null);
    };
    s.onerror = function () {
      cb(new Error('socket.io cdn'));
    };
    document.head.appendChild(s);
  }

  function connectChatSocket() {
    loadSocketIo(function (err) {
      if (err || typeof io !== 'function' || !state.token) return;
      if (chatSocket) {
        try {
          chatSocket.disconnect();
        } catch (_) {}
        chatSocket = null;
      }
      chatSocket = io(SOCKET_ORIGIN, {
        path: SOCKET_PATH,
        transports: ['websocket', 'polling'],
        reconnection: true,
        auth: {
          userId: 'tg-portal-' + state.companyId,
          profile: 'techguard-wa-portal'
        }
      });
      chatSocket.on('connect', function () {
        chatSocket.emit(
          'techguard-wa-chat:subscribe',
          { portalToken: state.token },
          function (ack) {
            state.chatSocketOk = !!(ack && ack.ok);
            setLiveBadge();
            flushP2lSupport();
          }
        );
      });
      chatSocket.on('techguard-wa-chat:thread', function (payload) {
        if (payload && payload.thread) upsertConversation(payload.thread);
        scheduleAiUsageRefresh();
      });
      chatSocket.on('disconnect', function () {
        state.chatSocketOk = false;
        setLiveBadge();
      });
      chatSocket.on('connect_error', function () {
        state.chatSocketOk = false;
        setLiveBadge();
      });
      chatSocket.off('chatMessage', onP2lSupportMessage);
      chatSocket.on('chatMessage', onP2lSupportMessage);
    });
  }

  function aiUsageSignature(u) {
    if (!u) return '';
    var last = u.lastCall || {};
    var month = u.month || {};
    return [
      u.requests,
      u.promptTokens,
      u.completionTokens,
      u.totalTokens,
      u.fallbacks,
      u.errors,
      last.at || '',
      last.source || '',
      month.requests,
      month.totalTokens,
      u.groqEnabled ? 1 : 0
    ].join('|');
  }

  /** El consumo vive en la empresa y la sesión solo se carga al entrar. */
  function patchAiUsage(u) {
    if (!u || !state.company) return;
    if (aiUsageSignature(state.company.aiUsage) === aiUsageSignature(u)) return;
    state.company.aiUsage = u;
    var host = document.querySelector('.tg-board__ai');
    if (!host) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = aiUsageHtml(u);
    if (wrap.firstElementChild) host.replaceWith(wrap.firstElementChild);
  }

  function pollAiUsage() {
    if (!state.token || !state.company) return;
    api('/public/portal/session')
      .then(function (out) {
        if (out && out.company && out.company.aiUsage) patchAiUsage(out.company.aiUsage);
        if (out && out.company) patchGeoUsage(out.company);
      })
      .catch(function () {});
  }

  function scheduleAiUsageRefresh() {
    if (aiUsageFetchTimer) clearTimeout(aiUsageFetchTimer);
    aiUsageFetchTimer = setTimeout(pollAiUsage, 1200);
  }

  function startChatLive() {
    stopChatLive();
    pollConversations();
    pollAiUsage();
    connectChatSocket();
    chatPollTimer = setInterval(pollConversations, 3000);
    chatLiveTimer = setInterval(updateLiveClassesOnly, 8000);
    aiUsageTimer = setInterval(pollAiUsage, 8000);
  }

  function chatsSectionHtml() {
    return (
      '<section class="tg-panel tg-board__chats tg-chats">' +
      '<div class="tg-panel__head"><div><h2>Conversaciones en vivo</h2>' +
      '<p class="tg-ctx__lead">Mensajes reales del webhook ↔ bot (memoria corta en BD).</p></div>' +
      '<div class="tg-chats__status">' +
      '<span class="tg-chats__live" id="tg-chat-live">○ Polling</span>' +
      '<span class="tg-muted" id="tg-chat-count">0 hilos</span></div></div>' +
      '<div class="tg-chats__body">' +
      '<aside class="tg-chats__list" id="tg-chat-list" aria-label="Hilos de WhatsApp"></aside>' +
      '<div class="tg-chats__thread" id="tg-chat-thread"></div>' +
      '</div></section>'
    );
  }

  /** El id viaja en la ruta (/company/<id>), en ?c= o en el hash. */
  function readCompanyId() {
    var injected = window.TG_COMPANY_ID || '';
    if (/^[a-f\d]{24}$/i.test(injected)) return String(injected).toLowerCase();
    var m = location.pathname.match(/\/company\/([a-f\d]{24})/i);
    if (m) return m[1].toLowerCase();
    var q = new URLSearchParams(location.search).get('c') || '';
    if (/^[a-f\d]{24}$/i.test(q)) return q.toLowerCase();
    var h = (location.hash || '').replace(/^#\/?(company\/)?/, '');
    return /^[a-f\d]{24}$/i.test(h) ? h.toLowerCase() : '';
  }

  function tokenKey() {
    return TOKEN_PREFIX + state.companyId;
  }

  function loadToken() {
    try {
      return localStorage.getItem(tokenKey()) || '';
    } catch (_) {
      return '';
    }
  }

  function saveToken(t) {
    try {
      if (t) localStorage.setItem(tokenKey(), t);
      else localStorage.removeItem(tokenKey());
    } catch (_) {}
  }

  /* ── API ─────────────────────────────────────────────────────────────── */

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try {
          data = txt ? JSON.parse(txt) : null;
        } catch (_) {
          data = { message: txt };
        }
        if (!res.ok) {
          var err = new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ── pantalla de acceso ──────────────────────────────────────────────── */

  function renderGate(msg) {
    mountP2lSupportChat(false);
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<div class="tg-gate"><div class="tg-gate__card">' +
      '<p class="tg-gate__brand">P2L</p>' +
      '<p class="tg-gate__eyebrow">Panel de empresa · Bot WhatsApp IA</p>' +
      '<p class="tg-gate__lead">Escribe la clave de empresa que te entregó el cluster. ' +
      'Solo la primera vez: después este enlace abrirá tu panel directamente.</p>' +
      (state.companyId ? '<code class="tg-gate__id">' + esc(state.companyId) + '</code>' : '') +
      (msg ? '<p class="tg-err">' + esc(msg) + '</p>' : '') +
      '<label class="tg-field"><span>Clave de empresa</span>' +
      '<input id="tg-key" type="password" autocomplete="current-password" placeholder="Clave de empresa" /></label>' +
      '<button type="button" class="tg-btn" id="tg-enter">Entrar a mi panel</button>' +
      '<p class="tg-gate__foot">¿Perdiste la clave? Escríbenos y te la regeneramos.</p>' +
      '</div></div>';

    var input = $('#tg-key');
    var btn = $('#tg-enter');
    input.focus();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') btn.click();
    });
    btn.addEventListener('click', function () {
      var key = input.value.trim();
      if (!key) return renderGate('Escribe tu clave de empresa.');
      btn.disabled = true;
      btn.textContent = 'Entrando…';
      api('/public/portal/login', {
        method: 'POST',
        body: { companyId: state.companyId, companyKey: key }
      })
        .then(function (out) {
          state.token = out.token;
          saveToken(out.token);
          state.company = out.company;
          state.connection = out.connection;
          renderPanel();
        })
        .catch(function (e) {
          renderGate(e.message || 'No pudimos validar la clave.');
        });
    });
  }

  /* ── panel ───────────────────────────────────────────────────────────── */

  function geoUsageHtml(c) {
    var g = c.components && c.components.geoapify;
    var u = c.geoUsage;
    if (!g || !g.enabled || !u) return '';
    var last = u.lastCall && u.lastCall.at ? formatWhen(u.lastCall.at) : '';
    return (
      '<section class="tg-panel tg-board__geo">' +
      '<div class="tg-panel__head"><h2>Consumo Geoapify</h2><span class="tg-chip">esta empresa</span></div>' +
      '<p class="tg-muted tg-ai__line">' + (u.requests || 0) + ' consultas hoy · ' +
      (u.monthRequests || 0) + ' en el mes' +
      (u.errors ? ' · ' + u.errors + ' con error' : '') +
      (last ? ' · última ' + esc(last) : '') +
      '</p></section>'
    );
  }

  function patchGeoUsage(company) {
    if (!company || !state.company) return;
    state.company.geoUsage = company.geoUsage;
    state.company.components = company.components || state.company.components;
    var host = document.querySelector('.tg-board__geo');
    var html = geoUsageHtml(state.company);
    if (!html) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      var ai = document.querySelector('.tg-board__ai');
      if (!ai) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      if (wrap.firstElementChild) ai.insertAdjacentElement('afterend', wrap.firstElementChild);
      return;
    }
    var wrap2 = document.createElement('div');
    wrap2.innerHTML = html;
    if (wrap2.firstElementChild) host.replaceWith(wrap2.firstElementChild);
  }

  function aiUsageHtml(u) {
    if (!u) return '';
    if (!u.groqEnabled) {
      return (
        '<section class="tg-panel tg-board__ai">' +
        '<div class="tg-panel__head"><h2>Consumo de IA</h2>' +
        '<span class="tg-chip">' + esc(u.model) + '</span></div>' +
        '<p class="tg-muted">Sin clave de Groq configurada: el bot responde con el mensaje base, sin IA. ' +
        'Pídele al cluster que active tu cuenta de Groq.</p></section>'
      );
    }
    var fill =
      u.quotaExhausted || u.percentUsed >= 95
        ? ' tg-ai__fill--danger'
        : u.percentUsed >= 75
          ? ' tg-ai__fill--warn'
          : '';
    var extra = '';
    if (u.fallbacks || u.errors) {
      extra +=
        '<p class="tg-muted tg-ai__line">' + u.fallbacks + ' respuestas sin IA hoy' +
        (u.errors ? ' · ' + u.errors + ' con error' : '') + '</p>';
    }
    if (u.lastCall) {
      extra +=
        '<p class="tg-muted tg-ai__line">Última: ' + esc(formatWhen(u.lastCall.at)) + ' · ' +
        (u.lastCall.source === 'groq' ? 'generada con IA' : 'mensaje base') +
        (u.lastCall.error ? ' · ' + esc(u.lastCall.error) : '') + '</p>';
    }
    return (
      '<section class="tg-panel tg-board__ai">' +
      '<div class="tg-panel__head"><h2>Consumo de IA</h2>' +
      '<span class="tg-chip">' + esc(u.model) + '</span></div>' +
      '<div class="tg-ai__row"><span class="tg-ai__big">' + u.requests +
      '<small> / ' + u.limit + ' respuestas con IA hoy</small></span>' +
      '<span class="tg-ai__cost">' + formatUsd(u.costUsd.total) + '</span></div>' +
      '<div class="tg-ai__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      u.percentUsed + '"><div class="tg-ai__fill' + fill + '" style="width:' + u.percentUsed + '%"></div></div>' +
      '<p class="tg-muted tg-ai__line">' + formatTokens(u.promptTokens) + ' tok entrada · ' +
      formatTokens(u.completionTokens) + ' tok salida · ' + u.tokenPercentUsed +
      '% del cupo diario de tokens' +
      (u.quotaExhausted ? '<strong class="tg-ai__warn"> · cupo agotado</strong>' : '') + '</p>' +
      '<p class="tg-muted tg-ai__line">Mes ' + esc(u.month.key) + ': ' + u.month.requests +
      ' respuestas · ' + formatTokens(u.month.totalTokens) + ' tok · <strong>' +
      formatUsd(u.month.costUsd.total) + '</strong></p>' +
      extra +
      '</section>'
    );
  }

  function waSectionHtml(c, conn) {
    var managed = c.waManagedBy;
    if (managed !== 'customer' && managed !== 'hybrid') {
      return (
        '<section class="tg-panel tg-board__wa"><h2>WhatsApp Cloud API</h2>' +
        '<p class="tg-muted">El cluster configura Meta por ti. Webhook: <code>' +
        esc((conn && conn.webhookUrl) || '') + '</code></p></section>'
      );
    }
    var HINT_BM = 'impórtalo de tu cuenta de WhatsApp en business.facebook.com';
    var HINT_APP = 'impórtalo de developers.facebook.com › configuración de la app › configuración básica';
    var HINT_TOKEN = 'impórtalo desde business.facebook.com → Usuarios del sistema → Generar token → token permanente';
    var f = function (id, label, hint, ph, val, type) {
      return (
        '<label class="tg-field"><span>' + esc(label) +
        (hint ? ' <em class="tg-hint">' + esc(hint) + '</em>' : '') + '</span>' +
        '<input id="' + id + '" type="' + (type || 'text') + '" placeholder="' + esc(ph) +
        '" value="' + esc(val || '') + '" /></label>'
      );
    };
    conn = conn || {};
    // Campo azul de solo lectura: el backend lo emite, el cliente solo lo copia a Meta.
    var ro = function (id, label, hint, val, btnId, btnTitle) {
      return (
        '<label class="tg-field tg-span-full"><span>' + esc(label) +
        ' <em class="tg-hint">' + esc(hint) + '</em></span>' +
        '<span class="tg-ro-wrap">' +
        '<input id="' + id + '" class="tg-input--ro" readonly tabindex="-1" value="' + esc(val || '') + '" />' +
        '<button type="button" class="tg-copy" id="' + btnId + '" title="' + esc(btnTitle) + '">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="9" width="12" height="12" rx="2"></rect>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
        '</svg></button></span></label>'
      );
    };
    return (
      '<section class="tg-panel tg-board__wa">' +
      '<div class="tg-panel__head"><h2>Conexión WhatsApp</h2>' +
      '<button type="button" class="tg-btn sm" id="tg-save-wa">Guardar WA</button></div>' +
      '<p class="tg-muted">Salud: <strong>' + esc(conn.health || 'unknown') + '</strong> · Último webhook: ' +
      (conn.lastWebhookAt ? esc(formatWhen(conn.lastWebhookAt)) : 'aún no llega ninguno') + '</p>' +
      '<div class="tg-grid tg-grid--wa">' +
      f('tg-wa-app', 'Meta App ID', HINT_BM, 'App ID', conn.metaAppId) +
      f('tg-wa-waba', 'WABA ID', HINT_BM, 'WABA ID', conn.wabaId) +
      f('tg-wa-phone', 'Phone Number ID', HINT_BM, 'Phone Number ID', conn.phoneNumberId) +
      f('tg-wa-display', 'Número visible', '', '+57…', conn.displayPhone) +
      ro(
        'tg-wa-webhook',
        'Webhook',
        'este es el webhook del bot en la app de Meta, en developers.facebook.com — ' +
          'Paso 2: Configuración de producción › URL de devolución de llamada',
        conn.webhookUrl,
        'tg-copy-webhook',
        'Copiar webhook'
      ) +
      ro(
        'tg-wa-verify',
        'Verify token',
        'expórtalo al campo «Token de verificación» del Paso 2: Configuración de producción, ' +
          'en developers.facebook.com — lo genera el cluster, es de solo lectura',
        conn.verifyToken,
        'tg-copy-verify',
        'Copiar verify token'
      ) +
      f('tg-wa-secret', 'App Secret', HINT_APP, conn.hasAppSecret ? '•••• guardado' : 'App Secret', '', 'password') +
      f('tg-wa-token', 'Access Token', HINT_TOKEN, conn.hasAccessToken ? '•••• guardado' : 'Access Token', '', 'password') +
      '</div></section>'
    );
  }

  function skillLearnHtml() {
    return (
      '<p class="tg-learn">Aprender más ' +
      '<a href="https://agentskills.io/" target="_blank" rel="noopener noreferrer">agentskills.io</a>' +
      '<a href="https://skills.md/" target="_blank" rel="noopener noreferrer">skills.md</a></p>'
    );
  }

  function wabaReady(c, conn) {
    var caps = c && c.planSpec && c.planSpec.agentCapabilities;
    var contracted = !caps || typeof caps.whatsapp !== 'boolean' || caps.whatsapp === true;
    var digits = String((conn && conn.displayPhone) || '').replace(/\D/g, '');
    return contracted && !!(conn && conn.phoneNumberId && conn.hasAccessToken && digits.length >= 8);
  }

  function waFloatSnippet(link, phoneLabel, companyId, ready) {
    var off = ready ? '' : ' is-off';
    var href = ready ? link : '#';
    var attrs = ready
      ? ' target="_blank" rel="noopener noreferrer"'
      : ' aria-disabled="true" title="Contrata o configura WhatsApp (WABA Meta) para activar este botón"';
    return '<style>\n' +
      '.wa-float {\n' +
      '  position: fixed;\n' +
      '  right: 18px;\n' +
      '  bottom: 18px;\n' +
      '  z-index: 40;\n' +
      '  width: 56px;\n' +
      '  height: 56px;\n' +
      '  display: block;\n' +
      '  line-height: 0;\n' +
      '  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28));\n' +
      '}\n' +
      '.wa-float svg { width: 56px; height: 56px; display: block; }\n' +
      '.wa-float:hover { filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28)) brightness(1.06); }\n' +
      '.wa-float.is-off { filter: grayscale(1); opacity: 0.55; cursor: not-allowed; }\n' +
      '.wa-float.is-off:hover { filter: grayscale(1); }\n' +
      '</style>\n' +
      '<a id="p2l-wa-float" class="wa-float' + off + '" href="' + href + '"' + attrs + ' data-company-id="' + esc(companyId || '') + '" aria-label="WhatsApp ' + phoneLabel + '">\n' +
      '  <svg viewBox="-2.73 0 1225.016 1225.016" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">\n' +
      '    <path fill="#E0E0E0" d="M1041.858 178.02C927.206 63.289 774.753.07 612.325 0 277.617 0 5.232 272.298 5.098 606.991c-.039 106.986 27.915 211.42 81.048 303.476L0 1225.016l321.898-84.406c88.689 48.368 188.547 73.855 290.166 73.896h.258.003c334.654 0 607.08-272.346 607.222-607.023.056-162.208-63.052-314.724-177.689-429.463zm-429.533 933.963h-.197c-90.578-.048-179.402-24.366-256.878-70.339l-18.438-10.93-191.021 50.083 51-186.176-12.013-19.087c-50.525-80.336-77.198-173.175-77.16-268.504.111-278.186 226.507-504.503 504.898-504.503 134.812.056 261.519 52.604 356.814 147.965 95.289 95.36 147.728 222.128 147.688 356.948-.118 278.195-226.522 504.543-504.693 504.543z"/>\n' +
      '    <linearGradient id="waFloatGreen" gradientUnits="userSpaceOnUse" x1="609.77" y1="1190.114" x2="609.77" y2="21.084">\n' +
      '      <stop offset="0" stop-color="#20b038"/>\n' +
      '      <stop offset="1" stop-color="#60d66a"/>\n' +
      '    </linearGradient>\n' +
      '    <path fill="url(#waFloatGreen)" d="M27.875 1190.114l82.211-300.18c-50.719-87.852-77.391-187.523-77.359-289.602.133-319.398 260.078-579.25 579.469-579.25 155.016.07 300.508 60.398 409.898 169.891 109.414 109.492 169.633 255.031 169.57 409.812-.133 319.406-260.094 579.281-579.445 579.281-.023 0 .016 0 0 0h-.258c-96.977-.031-192.266-24.375-276.898-70.5l-307.188 80.548z"/>\n' +
      '    <path fill="#fff" fill-rule="evenodd" d="M462.273 349.294c-11.234-24.977-23.062-25.477-33.75-25.914-8.742-.375-18.75-.352-28.742-.352-10 0-26.25 3.758-39.992 18.766-13.75 15.008-52.5 51.289-52.5 125.078 0 73.797 53.75 145.102 61.242 155.117 7.5 10 103.758 166.266 256.203 226.383 126.695 49.961 152.477 40.023 179.977 37.523s88.734-36.273 101.234-71.297c12.5-35.016 12.5-65.031 8.75-71.305-3.75-6.25-13.75-10-28.75-17.5s-88.734-43.789-102.484-48.789-23.75-7.5-33.75 7.516c-10 15-38.727 48.773-47.477 58.773-8.75 10.023-17.5 11.273-32.5 3.773-15-7.523-63.305-23.344-120.609-74.438-44.586-39.75-74.688-88.844-83.438-103.859-8.75-15-.938-23.125 6.586-30.602 6.734-6.719 15-17.508 22.5-26.266 7.484-8.758 9.984-15.008 14.984-25.008 5-10.016 2.5-18.773-1.25-26.273s-32.898-81.67-46.234-111.326z"/>\n' +
      '    <path fill="#fff" d="M1036.898 176.091C923.562 62.677 772.859.185 612.297.114 281.43.114 12.172 269.286 12.039 600.137 12 705.896 39.633 809.13 92.156 900.13L7 1211.067l318.203-83.438c87.672 47.812 186.383 73.008 286.836 73.047h.255.003c330.812 0 600.109-269.219 600.25-600.055.055-160.343-62.328-311.108-175.649-424.53zm-424.601 923.242h-.195c-89.539-.047-177.344-24.086-253.93-69.531l-18.227-10.805-188.828 49.508 50.414-184.039-11.875-18.867c-49.945-79.414-76.312-171.188-76.273-265.422.109-274.992 223.906-498.711 499.102-498.711 133.266.055 258.516 52 352.719 146.266 94.195 94.266 146.031 219.578 145.992 352.852-.118 274.999-223.923 498.749-498.899 498.749z"/>\n' +
      '  </svg>\n' +
      '</a>\n' +
      '<script>\n' +
      '(function(){var el=document.getElementById("p2l-wa-float");if(!el)return;var id=el.getAttribute("data-company-id")||"";el.addEventListener("click",function(ev){if(el.classList.contains("is-off"))ev.preventDefault();});if(!id)return;fetch("https://www.refactorii.com/p2l-tenant/api/p2l-techguard-whatsapp-bot/public/company/"+encodeURIComponent(id)+"/channels").then(function(r){return r.ok?r.json():null;}).then(function(data){if(!data||!data.whatsapp||!data.waLink)return;el.classList.remove("is-off");el.setAttribute("href",data.waLink);el.setAttribute("target","_blank");el.setAttribute("rel","noopener noreferrer");el.removeAttribute("aria-disabled");el.removeAttribute("title");}).catch(function(){});})();\n' +
      '</script>';
  }

  function floatPack(c, conn) {
    var name = String((c && c.name) || '').trim() || 'tu empresa';
    var ready = wabaReady(c, conn);
    var digits = String((conn && conn.displayPhone) || '').replace(/\D/g, '');
    var text = 'Hola agente de ' + name + '! quiero mas info para mi negocio';
    var link = ready ? ('https://wa.me/' + digits + '?text=' + encodeURIComponent(text)) : '#';
    var label = digits ? ('+' + digits) : name;
    return { name: name, link: link, html: waFloatSnippet(link, label, state.companyId, ready) };
  }

  function planOn(id) {
    if (isEnterprise() && id !== 'github' && id !== 'landing') return true;
    var caps = state.company && state.company.planSpec && state.company.planSpec.agentCapabilities;
    if (caps && typeof caps[id] === 'boolean') return caps[id] === true;
    return id !== 'devopsChat';
  }

  function markPlanOff(el) {
    if (!el || el.classList.contains('is-plan-off')) return;
    el.classList.add('is-plan-off');
    el.querySelectorAll('input, textarea, select, button').forEach(function (node) {
      node.disabled = true;
    });
    if (!el.querySelector('.tg-plan-lock')) {
      var note = document.createElement('p');
      note.className = 'tg-plan-lock';
      note.textContent = 'Tu plan no incluye esta capacidad.';
      el.insertBefore(note, el.firstChild);
    }
  }

  function applyPlanLocks() {
    if (!planOn('groq')) markPlanOff(document.querySelector('.tg-board__ai'));
    if (!planOn('geoapify')) markPlanOff(document.querySelector('.tg-board__geo'));
    if (!planOn('chat')) markPlanOff(document.querySelector('.tg-board__chats'));
    if (!planOn('skill')) {
      var skill = document.getElementById('tg-skill');
      if (skill) markPlanOff(skill.closest('.tg-ctx__block'));
    }
    if (!planOn('capabilities')) {
      var caps = document.getElementById('tg-caps');
      if (caps) markPlanOff(caps.closest('.tg-ctx__block'));
      markPlanOff(document.querySelector('.tg-ctx__block--links'));
    }
    if (!planOn('whatsapp')) {
      markPlanOff(document.querySelector('.tg-board__wa'));
      markPlanOff(document.querySelector('.tg-board__tutorial'));
      markPlanOff(document.querySelector('.tg-float-kit'));
    }
    if (!planOn('dropbox')) markPlanOff(document.querySelector('.tg-board__dropbox'));
    var ctxSave = document.getElementById('tg-save-ctx');
    if (ctxSave && !planOn('skill') && !planOn('capabilities')) ctxSave.disabled = true;
  }

  function isEnterprise() {
    var c = state.company || {};
    if (c.enterprise) return true;
    var spec = c.planSpec || {};
    var code = String(spec.code || '').toLowerCase();
    var name = String(spec.name || '').toLowerCase();
    return code === 'enterprise' || name === 'enterprise' || Number(c.plan) === 4;
  }

  function companyHeadline(c) {
    var name = (c && c.name) || 'Empresa';
    var plan = (c && c.planSpec && c.planSpec.name) || '';
    var bits = [name, 'Bot WhatsApp IA'];
    if (plan) bits.push('Plan ' + plan);
    return bits.map(function (bit) { return esc(bit); }).join('<span class="tg-co__sep">|</span>');
  }

  function dropboxSectionHtml(c) {
    var at = (c && c.agentTech) || {};
    var on = planOn('dropbox');
    return (
      '<section class="tg-panel tg-board__dropbox">' +
      '<div class="tg-panel__head"><div><h2>Dropbox</h2>' +
      '<p class="tg-muted">' +
      (on
        ? 'App key, app secret, refresh token y carpeta de esta empresa. El cluster también puede cargarlos en la tarjeta Dropbox.'
        : 'Tu plan no incluye Dropbox.') +
      '</p></div>' +
      (on ? '<button type="button" class="tg-btn sm" id="tg-save-dropbox">Guardar Dropbox</button>' : '') +
      '</div>' +
      (on
        ? '<div class="tg-grid">' +
          '<label class="tg-field"><span>App key</span><input id="tg-dbx-key" value="' + esc(at.dropboxAppKey) + '" placeholder="DROPBOX_APP_KEY" /></label>' +
          '<label class="tg-field"><span>Carpeta</span><input id="tg-dbx-folder" value="' + esc(at.dropboxAppFolder) + '" placeholder="DROPBOX_APP_FOLDER" /></label>' +
          '<label class="tg-field"><span>App secret</span><input id="tg-dbx-secret" type="password" autocomplete="off" placeholder="' + esc(at.hasDropboxAppSecret ? 'App secret · ••••' : 'DROPBOX_APP_SECRET') + '" /></label>' +
          '<label class="tg-field"><span>Refresh token</span><input id="tg-dbx-refresh" type="password" autocomplete="off" placeholder="' + esc(at.hasDropboxRefreshToken ? 'Refresh token · ••••' : 'DROPBOX_REFRESH_TOKEN') + '" /></label>' +
          '</div>'
        : '') +
      '</section>'
    );
  }

  var LOGO = {
    groq: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#F55036"/><path fill="#fff" d="M7.2 16.4 12 5.6l4.8 10.8h-2.1l-.9-2.1H10.2l-.9 2.1H7.2zm4.8-9.1-1.6 3.8h3.2L12 7.3z"/></svg>',
    dropbox: '<svg viewBox="0 0 24 24"><path fill="#0061FF" d="M6 1.5 12 5.4 6 9.3 0 5.4 6 1.5zm12 0 6 3.9-6 3.9-6-3.9 6-3.9zM0 13.2 6 9.3l6 3.9L6 17.1 0 13.2zm18-3.9 6 3.9L18 17.1l-6-3.9 6-3.9zM6 18.4l6-3.9 6 3.9-6 3.9-6-3.9z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24"><path fill="#25D366" d="M12.04 2C6.58 2 2.15 6.4 2.15 11.83c0 1.74.46 3.44 1.34 4.94L2 22l5.39-1.41a10.1 10.1 0 0 0 4.65 1.18h.01c5.46 0 9.89-4.4 9.89-9.83C21.94 6.4 17.5 2 12.04 2zm5.76 13.86c-.24.68-1.4 1.25-1.94 1.33-.5.07-1.12.1-1.81-.11-.41-.13-.94-.31-1.62-.6-2.85-1.23-4.71-4.1-4.85-4.29-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07 1-2.36.24-.26.64-.38 1.02-.38.12 0 .23 0 .33.01.3.01.45.03.65.5.24.58.82 2 .89 2.15.07.14.12.31.02.5-.09.19-.14.31-.28.48-.14.16-.29.36-.41.48-.14.14-.28.28-.12.55.16.26.71 1.17 1.52 1.9 1.05.93 1.93 1.22 2.2 1.36.28.14.44.12.6-.07.16-.19.69-.8.87-1.08.19-.26.37-.22.62-.13.26.1 1.62.76 1.9.9.28.14.46.21.53.33.07.12.07.68-.17 1.36z"/></svg>',
    atlas: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#001E2B"/><path fill="#00ED64" d="M12.2 3.2c.6 2.2-.2 3.6-1.4 5.1 2.4.2 4.8-.4 7.2-2.2-.4 5.2-.2 9.6-2.8 12.8-1.7 2.2-4 3.2-6.4 2.8.1-2.1.6-5 2.3-8.6-1.7 2.7-2.6 5.2-2.9 7.5-2.3-.4-3.8-2.2-3.8-4.8 0-4.4 2.4-8.4 6.6-11.8.4-.3.8-.6 1.2-.8z"/></svg>',
    geoapify: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#0B6E4F"/><path fill="#fff" d="M12 4.6c-3.1 0-5.4 2.3-5.4 5.3 0 4 5.4 9.5 5.4 9.5s5.4-5.5 5.4-9.5c0-3-2.3-5.3-5.4-5.3zm0 7.2a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z"/></svg>',
    p2l: '<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1a9f63"/><text x="16" y="21" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="Inter,Arial">P2L</text></svg>'
  };

  var CARD_THREADS = [
    { from: 'groq', to: 'skill', color: '#f97316', label: 'La inferencia lee el skill' },
    { from: 'groq', to: 'capabilities', color: '#f97316', label: 'La inferencia usa las capacidades' },
    { from: 'groq', to: 'chat', color: '#f97316', label: 'La inferencia responde en las conversaciones de WhatsApp' },
    { from: 'dropbox', to: 'capabilities', color: '#0061FF', label: 'Dropbox entra en las capacidades si está activo' },
    { from: 'whatsapp', to: 'skill', color: '#25D366', label: 'El skill es el asistente de esa cuenta de WhatsApp' },
    { from: 'whatsapp', to: 'capabilities', color: '#25D366', label: 'WhatsApp usa las capacidades del agente' },
    { from: 'whatsapp', to: 'chat', color: '#25D366', label: 'Las conversaciones salen de la cuenta de WhatsApp' },
    { from: 'atlas', to: 'chat', color: '#d8b4fe', label: 'Los hilos se guardan en la base de datos' },
    { from: 'geoapify', to: 'mobility', color: '#0B6E4F', label: 'Movilidad geocodifica con Geoapify' },
    { from: 'geoapify', to: 'cad', color: '#0B6E4F', label: 'CAD alert panel usa Geoapify' }
  ];

  var modalKind = '';

  function on(v) {
    return v ? 'Activo' : 'Apagado';
  }

  function enterpriseCards(c, conn) {
    var waOn = Boolean(conn && conn.phoneNumberId);
    var at = (c && c.agentTech) || {};
    var list = Array.isArray(c.productCapabilities && c.productCapabilities.capabilities)
      ? c.productCapabilities.capabilities
      : [];
    var dropboxCap = list.some(function (item) {
      return String((item && item.id) || '').toLowerCase() === 'dropbox';
    });
    var services = [
      { kind: 'groq', logo: 'groq', wallpaper: false, label: 'Inferencia IA | Agente', state: at.groqAccountEmail || (at.hasGroqKey ? 'Clave guardada' : 'Sin clave'), active: Boolean(at.hasGroqKey) },
      { kind: 'dropbox', logo: 'dropbox', wallpaper: false, label: 'Dropbox | Almacenamiento de imagenes', state: at.hasDropboxRefreshToken ? 'OAuth de la empresa' : 'Sin refresh token', active: Boolean(at.hasDropboxRefreshToken) },
      { kind: 'whatsapp', logo: 'whatsapp', wallpaper: false, label: 'Whatsapp | META Business Account', state: 'WhatsApp Business Account', items: ['Configuración de tu app META y Whatsapp business acount', 'link de tu agente Whatsapp'], active: waOn },
      { kind: 'atlas', logo: 'atlas', wallpaper: false, label: 'Base de datos | Almacenamiento Conversaciones Agente', state: c.hasDataMongo ? 'Atlas propio' : 'BD del tenant', active: Boolean(c.hasDataMongo) },
      { kind: 'geoapify', logo: 'geoapify', wallpaper: false, label: 'Geoapify | Georreferenciación API', state: on(c.components && c.components.geoapify && c.components.geoapify.enabled), active: Boolean(c.components && c.components.geoapify && c.components.geoapify.enabled) }
    ];
    var cafe = [
      { kind: 'plans', logo: 'p2l', wallpaper: true, label: 'Panel de empresa', state: (c.panelGithub && c.panelGithub.pagesUrl) ? 'Panel publicado' : 'Publica tu panel', inCompanyPanel: true, active: Boolean(c.panelGithub && c.panelGithub.pagesUrl) },
      { kind: 'skill', logo: 'p2l', wallpaper: true, label: 'Skill del agente IA (Asistente de Whatsapp)', state: waOn ? 'Skill del agente' : 'Saludo del agente', inCompanyPanel: true, active: Boolean(c.skills && c.skills[0] && String(c.skills[0].content || '').trim()) },
      { kind: 'capabilities', logo: 'p2l', wallpaper: true, label: 'Capacidades del agente IA (Asistente de Whatsapp)', state: dropboxCap ? 'Dropbox en la lista' : (list.length + ' en la lista'), inCompanyPanel: true, active: list.length > 0 },
      { kind: 'chat', logo: 'p2l', wallpaper: true, label: 'Conversaciones en Whatsapp', state: 'Hilos del panel', inCompanyPanel: true, active: waOn },
      { kind: 'mobility', logo: 'p2l', wallpaper: true, label: 'Movilidad', state: on(c.components && c.components.mobility && c.components.mobility.enabled), inCompanyPanel: true, active: Boolean(c.components && c.components.mobility && c.components.mobility.enabled) },
      { kind: 'cad', logo: 'p2l', wallpaper: true, label: 'CAD alert panel', state: on(c.components && c.components.cad && c.components.cad.enabled), active: Boolean(c.components && c.components.cad && c.components.cad.enabled) },
      { kind: 'devopsChat', logo: 'p2l', wallpaper: true, label: 'Soporte Devops P2L Chat', state: 'Incluido en el plan', inCompanyPanel: true, active: true }
    ];
    return { services: services, cafe: cafe };
  }

  function cardHtml(card) {
    var items = (card.items || []).map(function (item) {
      return '<span class="tg-comp__item">– ' + esc(item) + '</span>';
    }).join('');
    return (
      '<div class="tg-comp-slot" data-kind="' + card.kind + '">' +
      '<button type="button" class="tg-comp' + (card.wallpaper ? ' tg-comp--wa' : '') + '" data-open="' + card.kind + '">' +
      '<span class="tg-comp__logo">' + (LOGO[card.logo] || LOGO.p2l) + '</span>' +
      '<span class="tg-comp__body"><strong>' + esc(card.label) + '</strong>' +
      '<span class="tg-comp__state">' + esc(card.state) + '</span>' +
      (card.inCompanyPanel ? '<em>disponible en panel de empresa</em>' : '') +
      items +
      '</span>' +
      '<span class="tg-switch' + (card.active ? ' tg-switch--on' : '') + '" aria-hidden="true"></span>' +
      '</button></div>'
    );
  }

  function toolsBoardHtml(c, conn) {
    var groups = enterpriseCards(c, conn);
    return (
      '<section class="tg-panel tg-tools"><h2>Componentes MCP (Model Context Protocol) · ' + esc(c.name || 'Empresa') + '</h2>' +
      '<div class="tg-comp-board" id="tg-comp-board">' +
      '<div class="tg-comp-grid">' + groups.services.map(cardHtml).join('') + '</div>' +
      '<div class="tg-threads-gap" aria-hidden="true"></div>' +
      '<div class="tg-comp-grid tg-comp-grid--p2l">' + groups.cafe.map(cardHtml).join('') + '</div>' +
      '<svg class="tg-threads" id="tg-threads"></svg>' +
      '</div></section>'
    );
  }

  function fieldVal(id) {
    var n = document.getElementById(id);
    return n ? String(n.value || '').trim() : '';
  }

  function fieldChecked(id) {
    var n = document.getElementById(id);
    return !!(n && n.checked);
  }

  function accountFields(kind) {
    if (kind === 'skill' || kind === 'chat' || kind === 'mobility' || kind === 'capabilities' || kind === 'devopsChat') return '';
    return (
      '<label class="tg-field">Correo de la cuenta<input id="tg-m-email" type="text" autocomplete="off" placeholder="correo de la cuenta" /></label>' +
      '<label class="tg-field">Contraseña<input id="tg-m-pass" type="text" autocomplete="off" placeholder="contraseña" /></label>'
    );
  }

  function modalInner(kind, c, conn) {
    var at = c.agentTech || {};
    var pack = floatPack(c, conn);
    if (kind === 'groq') {
      return (
        accountFields(kind) +
        '<a class="tg-ext-link" href="https://groq.com/" target="_blank" rel="noopener">Abrir Groq → groq.com</a>' +
        '<p class="tg-muted tg-field--wide">Inferencia IA de ' + esc(c.name) + '. Si dejas la clave vacía, sigue la cuenta Groq actual.</p>' +
        '<label class="tg-field tg-field--wide">GROQ_API_KEY<input id="tg-m-groq-key" type="password" placeholder="' + esc(at.hasGroqKey ? 'Groq · ••••' : 'gsk_…') + '" /></label>' +
        '<label class="tg-field tg-field--wide">GROQ_ENDPOINT<input id="tg-m-groq-ep" placeholder="https://api.groq.com/openai/v1" value="' + esc(at.groqEndpoint) + '" /></label>' +
        '<label class="tg-field tg-field--wide">GROQ_MODEL<input id="tg-m-groq-model" placeholder="openai/gpt-oss-20b" value="' + esc(at.groqModel) + '" /></label>' +
        '<label class="tg-field">GROQ_RPM_LIMIT<input id="tg-m-groq-rpm" type="number" min="0" value="' + esc(at.groqRpmLimit || '') + '" /></label>' +
        '<label class="tg-field">GROQ_TPM_LIMIT<input id="tg-m-groq-tpm" type="number" min="0" value="' + esc(at.groqTpmLimit || '') + '" /></label>' +
        '<label class="tg-field">GROQ_REASONING_EFFORT<input id="tg-m-groq-effort" placeholder="low" value="' + esc(at.groqReasoningEffort) + '" /></label>' +
        '<label class="tg-field">SABELOTODO_AI_DAILY_REQUEST_LIMIT<input id="tg-m-groq-dreq" type="number" min="0" value="' + esc(at.groqDailyRequestLimit || '') + '" /></label>' +
        '<label class="tg-field">SABELOTODO_AI_DAILY_TOKEN_LIMIT<input id="tg-m-groq-dtok" type="number" min="0" value="' + esc(at.groqDailyTokenLimit || '') + '" /></label>' +
        '<label class="tg-check tg-field--wide"><input id="tg-m-groq-tls" type="checkbox"' + (at.groqInsecureTls ? ' checked' : '') + ' /> GROQ_INSECURE_TLS</label>'
      );
    }
    if (kind === 'dropbox') {
      return (
        accountFields(kind) +
        '<a class="tg-ext-link" href="https://www.dropbox.com/" target="_blank" rel="noopener">Abrir Dropbox → dropbox.com</a>' +
        '<p class="tg-muted tg-field--wide">App key, app secret, refresh token y carpeta. El access token se renueva solo.</p>' +
        '<label class="tg-field">App key<input id="tg-m-dbx-key" value="' + esc(at.dropboxAppKey) + '" placeholder="DROPBOX_APP_KEY" /></label>' +
        '<label class="tg-field">Carpeta<input id="tg-m-dbx-folder" value="' + esc(at.dropboxAppFolder) + '" placeholder="DROPBOX_APP_FOLDER" /></label>' +
        '<label class="tg-field">App secret<input id="tg-m-dbx-secret" type="password" placeholder="' + esc(at.hasDropboxAppSecret ? 'App secret · ••••' : 'DROPBOX_APP_SECRET') + '" /></label>' +
        '<label class="tg-field">Refresh token<input id="tg-m-dbx-refresh" type="password" placeholder="' + esc(at.hasDropboxRefreshToken ? 'Refresh token · ••••' : 'DROPBOX_REFRESH_TOKEN') + '" /></label>'
      );
    }
    if (kind === 'whatsapp') {
      conn = conn || {};
      return (
        accountFields(kind) +
        '<div class="tg-wa-kit"><p class="tg-wa-kit__title">Enlace para compartir</p>' +
        '<p class="tg-muted">Comparte este enlace del agente de ' + esc(c.name) + '.</p>' +
        '<p class="tg-wa-kit__link">' + esc(pack.link) + '</p>' +
        '<button type="button" class="tg-btn ghost sm" id="tg-m-copy-link">Copiar enlace</button>' +
        '<p class="tg-wa-kit__title">HTML del botón flotante</p>' +
        '<pre class="tg-wa-kit__code" id="tg-m-float">' + esc(pack.html) + '</pre>' +
        '<button type="button" class="tg-btn ghost sm" id="tg-m-copy-html">Copiar HTML</button></div>' +
        '<p class="tg-muted tg-field--wide">Salud: <strong>' + esc(conn.health || 'unknown') + '</strong> · Último webhook: ' +
        (conn.lastWebhookAt ? esc(formatWhen(conn.lastWebhookAt)) : 'aún no llega ninguno') + '</p>' +
        '<label class="tg-field">Meta App ID<input id="tg-m-wa-app" value="' + esc(conn.metaAppId) + '" /></label>' +
        '<label class="tg-field">WABA ID<input id="tg-m-wa-waba" value="' + esc(conn.wabaId) + '" /></label>' +
        '<label class="tg-field">Phone Number ID<input id="tg-m-wa-phone" value="' + esc(conn.phoneNumberId) + '" /></label>' +
        '<label class="tg-field">Número visible<input id="tg-m-wa-display" value="' + esc(conn.displayPhone) + '" placeholder="+57…" /></label>' +
        '<label class="tg-field tg-field--wide">Webhook<span class="tg-wa-ro"><input readonly value="' + esc(conn.webhookUrl || '') + '" /><button type="button" class="tg-btn ghost sm" id="tg-m-copy-hook">Copiar</button></span></label>' +
        '<label class="tg-field tg-field--wide">Verify token<span class="tg-wa-ro"><input readonly value="' + esc(conn.verifyToken || '') + '" /><button type="button" class="tg-btn ghost sm" id="tg-m-copy-verify">Copiar</button></span></label>' +
        '<label class="tg-field">App Secret<input id="tg-m-wa-secret" type="password" placeholder="' + esc(conn.hasAppSecret ? '•••• guardado' : 'App Secret') + '" /></label>' +
        '<label class="tg-field">Access Token<input id="tg-m-wa-token" type="password" placeholder="' + esc(conn.hasAccessToken ? '•••• guardado' : 'Access Token') + '" /></label>'
      );
    }
    if (kind === 'atlas') {
      return (
        accountFields(kind) +
        '<a class="tg-ext-link" href="https://account.mongodb.com/account/login" target="_blank" rel="noopener">Abrir MongoDB Atlas</a>' +
        '<p class="tg-muted tg-field--wide">Vacío: hilos y borradores siguen en la base del tenant.</p>' +
        '<label class="tg-field tg-field--wide">URL de Mongo Atlas<input id="tg-m-mongo" type="password" placeholder="' + esc(c.hasDataMongo ? 'mongodb · ••••' : 'mongodb+srv://…') + '" /></label>' +
        (c.hasDataMongo ? '<label class="tg-check tg-field--wide"><input id="tg-m-mongo-clear" type="checkbox" /> Quitar la URL y volver a la base del tenant</label>' : '')
      );
    }
    if (kind === 'geoapify') {
      var geo = (c.components && c.components.geoapify) || {};
      return (
        accountFields(kind) +
        '<a class="tg-ext-link" href="https://www.geoapify.com/" target="_blank" rel="noopener">Abrir Geoapify</a>' +
        '<label class="tg-check tg-field--wide"><input id="tg-m-geo-on" type="checkbox"' + (geo.enabled ? ' checked' : '') + ' /> Geocodificar con la key de esta empresa</label>' +
        '<label class="tg-field tg-field--wide">API key<input id="tg-m-geo-key" type="password" placeholder="' + esc(geo.hasKey ? 'Geoapify · ••••' : 'API key') + '" /></label>'
      );
    }
    if (kind === 'skill') {
      return (
        '<p class="tg-muted tg-field--wide">El mismo texto del panel. Se puede editar aquí.</p>' +
        '<label class="tg-field tg-field--wide">Skill<textarea id="tg-m-skill" class="tg-skill-area"></textarea></label>'
      );
    }
    if (kind === 'capabilities') {
      return (
        '<p class="tg-muted tg-field--wide">Al activar un MCP, queda disponible como herramienta del agente.</p>' +
        '<label class="tg-field tg-field--wide">Capacidades de producto<textarea id="tg-m-caps" class="tg-skill-area"></textarea></label>'
      );
    }
    if (kind === 'chat') {
      var rows = (state.conversations || []).map(function (t) {
        return '<li>' + esc(t.label || ('+' + t.waFrom)) + ' · ' + esc(t.preview || '—') + '</li>';
      }).join('');
      return '<p class="tg-muted tg-field--wide">Las conversaciones ya viven en el panel.</p>' +
        (rows ? '<ul class="tg-field--wide">' + rows + '</ul>' : '<p class="tg-muted tg-field--wide">Sin hilos todavía.</p>');
    }
    if (kind === 'mobility') {
      var m = (c.components && c.components.mobility) || {};
      return (
        '<label class="tg-check tg-field--wide"><input id="tg-m-mob-on" type="checkbox"' + (m.enabled ? ' checked' : '') + ' /> Pedir ubicación y viaje por WhatsApp</label>' +
        '<label class="tg-field tg-field--wide">URL que el agente entrega<input id="tg-m-mob-req" value="' + esc(m.requestUrl) + '" /></label>' +
        '<label class="tg-field tg-field--wide">White label pasajero/conductor<input id="tg-m-mob-pass" value="' + esc(m.passengerWhiteLabelUrl) + '" /></label>' +
        '<label class="tg-field tg-field--wide">White label panel empresa<input id="tg-m-mob-co" value="' + esc(m.companyPanelWhiteLabelUrl) + '" /></label>'
      );
    }
    if (kind === 'cad') {
      var cad = (c.components && c.components.cad) || {};
      var types = cad.types || [];
      return (
        accountFields(kind) +
        '<label class="tg-check tg-field--wide"><input id="tg-m-cad-on" type="checkbox"' + (cad.enabled ? ' checked' : '') + ' /> Recibir tipos de solicitud en el panel CAD</label>' +
        '<label class="tg-field tg-field--wide">URL del panel<input id="tg-m-cad-url" value="' + esc(cad.panelUrl) + '" /></label>' +
        '<label class="tg-check"><input id="tg-m-cad-panico" type="checkbox"' + (types.indexOf('panico') >= 0 ? ' checked' : '') + ' /> Pánico</label>' +
        '<label class="tg-check"><input id="tg-m-cad-dom" type="checkbox"' + (types.indexOf('domicilio') >= 0 ? ' checked' : '') + ' /> Domicilio</label>'
      );
    }
    if (kind === 'plans') {
      var plans = Array.isArray(c.landingPlans) ? c.landingPlans : [];
      var rowsHtml = plans.map(function (p, i) {
        return '<div class="tg-field--wide" data-plan="' + i + '">' +
          '<input data-k="name" value="' + esc(p.name) + '" placeholder="Nombre" />' +
          '<input data-k="priceCop" type="number" value="' + esc(p.priceCop || 0) + '" placeholder="Precio COP" />' +
          '<input data-k="seats" value="' + esc(p.seats) + '" placeholder="Cupos" />' +
          '<input data-k="text" value="' + esc(p.text) + '" placeholder="Texto" />' +
          '<label class="tg-check"><input data-k="active" type="checkbox"' + (p.active ? ' checked' : '') + ' /> Activo</label>' +
          '</div>';
      }).join('');
      return (
        accountFields(kind) +
        '<p class="tg-muted tg-field--wide">Estos planes van a planes.json del panel. No cambian el catálogo del cluster.</p>' +
        '<label class="tg-field tg-field--wide">Landing URL<input id="tg-m-landing-url" value="' + esc(c.landingUrl) + '" placeholder="https://…" /></label>' +
        '<div id="tg-m-plans">' + rowsHtml + '</div>' +
        '<button type="button" class="tg-btn ghost sm" id="tg-m-add-plan">Agregar plan</button>'
      );
    }
    if (kind === 'devopsChat') {
      return '<p class="tg-muted tg-field--wide">Incluido en Enterprise. El chat de soporte del panel se puede usar.</p>';
    }
    return '';
  }

  var MODAL_TITLES = {
    groq: 'Inferencia IA | Agente',
    dropbox: 'Dropbox | Almacenamiento de imagenes',
    whatsapp: 'Whatsapp | META Business Account',
    atlas: 'Base de datos | Almacenamiento Conversaciones Agente',
    geoapify: 'Geoapify | Georreferenciación API',
    plans: 'Panel de empresa',
    skill: 'Skill del agente IA',
    capabilities: 'Capacidades del agente IA',
    chat: 'Conversaciones en Whatsapp',
    mobility: 'Movilidad',
    cad: 'CAD alert panel',
    devopsChat: 'Soporte Devops P2L Chat'
  };

  function closeToolModal() {
    modalKind = '';
    var node = document.getElementById('tg-tool-modal');
    if (node) node.remove();
  }

  function openToolModal(kind) {
    var c = state.company || {};
    var conn = state.connection || {};
    var pack = floatPack(c, conn);
    closeToolModal();
    modalKind = kind;
    var wrap = document.createElement('div');
    wrap.id = 'tg-tool-modal';
    wrap.className = 'tg-modal';
    wrap.innerHTML =
      '<div class="tg-modal__card" role="dialog" aria-modal="true">' +
      '<div class="tg-modal__head"><div class="tg-modal__head-main">' +
      '<span class="tg-modal__logo">' + (LOGO[kind] || LOGO.p2l) + '</span>' +
      '<div><p class="tg-modal__company">Empresa: <strong>' + esc(c.name) + '</strong></p>' +
      '<h3>' + esc(MODAL_TITLES[kind] || kind) +
      (LOGO[kind] && kind !== 'p2l' ? ' <span class="tg-modal__ext-tag">| Componente externo - API</span>' : '') +
      '</h3></div></div>' +
      '<button type="button" class="tg-btn ghost sm" id="tg-m-close">Cerrar</button></div>' +
      '<div class="tg-plan-fields--modal">' + modalInner(kind, c, conn) + '</div>' +
      '<div class="tg-modal__foot">' +
      (kind === 'dropbox' ? '<button type="button" class="tg-btn ghost sm" id="tg-m-test-dbx">Probar conexión</button>' : '') +
      (kind === 'chat' || kind === 'devopsChat' ? '' : '<button type="button" class="tg-btn sm" id="tg-m-save">Guardar</button>') +
      '</div></div>';
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap) closeToolModal();
    });
    document.body.appendChild(wrap);
    if (kind === 'skill') {
      var skillEl = document.getElementById('tg-m-skill');
      if (skillEl) skillEl.value = (c.skills && c.skills[0] && c.skills[0].content) || '';
    }
    if (kind === 'capabilities') {
      var capsEl = document.getElementById('tg-m-caps');
      if (capsEl) {
        capsEl.value = JSON.stringify(
          c.productCapabilities && typeof c.productCapabilities === 'object'
            ? c.productCapabilities
            : { capabilities: [] },
          null,
          2
        );
      }
    }
    document.getElementById('tg-m-close').addEventListener('click', closeToolModal);
    var saveBtn = document.getElementById('tg-m-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveToolModal(false); });
    var testBtn = document.getElementById('tg-m-test-dbx');
    if (testBtn) testBtn.addEventListener('click', testDropboxModal);
    bindModalCopies(pack, conn);
    var addPlan = document.getElementById('tg-m-add-plan');
    if (addPlan) {
      addPlan.addEventListener('click', function () {
        var host = document.getElementById('tg-m-plans');
        if (!host) return;
        var i = host.children.length;
        var row = document.createElement('div');
        row.className = 'tg-field--wide';
        row.setAttribute('data-plan', String(i));
        row.innerHTML = '<input data-k="name" placeholder="Nombre" /><input data-k="priceCop" type="number" placeholder="Precio COP" /><input data-k="seats" placeholder="Cupos" /><input data-k="text" placeholder="Texto" /><label class="tg-check"><input data-k="active" type="checkbox" /> Activo</label>';
        host.appendChild(row);
      });
    }
  }

  function bindModalCopies(pack, conn) {
    function copy(id, text) {
      var btn = document.getElementById(id);
      if (!btn || !text || !navigator.clipboard) return;
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(text).then(function () { flash('note', 'Copiado'); });
      });
    }
    copy('tg-m-copy-link', pack && pack.link);
    copy('tg-m-copy-html', pack && pack.html);
    copy('tg-m-copy-hook', conn && conn.webhookUrl);
    copy('tg-m-copy-verify', conn && conn.verifyToken);
  }

  function saveAccountIfNeeded(kind) {
    if (kind === 'skill' || kind === 'chat' || kind === 'mobility' || kind === 'capabilities' || kind === 'devopsChat') {
      return Promise.resolve();
    }
    var email = fieldVal('tg-m-email');
    var password = fieldVal('tg-m-pass');
    if (!email && !password) return Promise.resolve();
    return api('/public/portal/section', {
      method: 'PUT',
      body: { section: 'serviceAccount', kind: kind, email: email, password: password }
    }).then(function (out) {
      if (out.company) state.company = out.company;
    });
  }

  function testDropboxModal() {
    saveToolModal(true).then(function () {
      return api('/public/portal/dropbox/test', { method: 'POST', body: {} });
    }).then(function (out) {
      var minutes = Math.round(Number((out && out.expiresIn) || 0) / 60);
      flash('note', 'Dropbox renovó el token (~' + minutes + ' min). Carpeta: ' + ((out && out.folder) || '—') + '.');
    }).catch(onError);
  }

  function saveToolModal(keepOpen) {
    var kind = modalKind;
    var c = state.company || {};
    var next;
    if (kind === 'groq') {
      next = api('/public/portal/agent-tech', {
        method: 'PUT',
        body: {
          groqAccountEmail: fieldVal('tg-m-email'),
          groqKey: fieldVal('tg-m-groq-key'),
          groqEndpoint: fieldVal('tg-m-groq-ep'),
          groqModel: fieldVal('tg-m-groq-model'),
          groqReasoningEffort: fieldVal('tg-m-groq-effort'),
          groqRpmLimit: fieldVal('tg-m-groq-rpm'),
          groqTpmLimit: fieldVal('tg-m-groq-tpm'),
          groqDailyRequestLimit: fieldVal('tg-m-groq-dreq'),
          groqDailyTokenLimit: fieldVal('tg-m-groq-dtok'),
          groqInsecureTls: fieldChecked('tg-m-groq-tls')
        }
      });
    } else if (kind === 'dropbox') {
      next = api('/public/portal/dropbox', {
        method: 'PUT',
        body: {
          dropboxAccountEmail: fieldVal('tg-m-email'),
          dropboxAppKey: fieldVal('tg-m-dbx-key'),
          dropboxAppFolder: fieldVal('tg-m-dbx-folder'),
          dropboxAppSecret: fieldVal('tg-m-dbx-secret'),
          dropboxRefreshToken: fieldVal('tg-m-dbx-refresh')
        }
      });
    } else if (kind === 'whatsapp') {
      var waBody = {
        metaAppId: fieldVal('tg-m-wa-app'),
        wabaId: fieldVal('tg-m-wa-waba'),
        phoneNumberId: fieldVal('tg-m-wa-phone'),
        displayPhone: fieldVal('tg-m-wa-display')
      };
      var secret = fieldVal('tg-m-wa-secret');
      var tok = fieldVal('tg-m-wa-token');
      if (secret) waBody.appSecret = secret;
      if (tok) waBody.accessToken = tok;
      next = api('/public/portal/connection', { method: 'PUT', body: waBody });
    } else if (kind === 'atlas') {
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'atlas', mongoUri: fieldVal('tg-m-mongo'), clear: fieldChecked('tg-m-mongo-clear') }
      });
    } else if (kind === 'geoapify') {
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'geoapify', enabled: fieldChecked('tg-m-geo-on'), apiKey: fieldVal('tg-m-geo-key') }
      });
    } else if (kind === 'skill') {
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'skill', content: (document.getElementById('tg-m-skill') || {}).value || '' }
      });
    } else if (kind === 'capabilities') {
      var parsed;
      try {
        parsed = JSON.parse((document.getElementById('tg-m-caps') || {}).value || '{"capabilities":[]}');
      } catch (e) {
        flash('err', 'Capacidades JSON inválido');
        return Promise.reject(e);
      }
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'capabilities', productCapabilities: parsed }
      });
    } else if (kind === 'mobility') {
      next = api('/public/portal/section', {
        method: 'PUT',
        body: {
          section: 'mobility',
          enabled: fieldChecked('tg-m-mob-on'),
          requestUrl: fieldVal('tg-m-mob-req'),
          passengerWhiteLabelUrl: fieldVal('tg-m-mob-pass'),
          companyPanelWhiteLabelUrl: fieldVal('tg-m-mob-co')
        }
      });
    } else if (kind === 'cad') {
      var types = [];
      if (fieldChecked('tg-m-cad-panico')) types.push('panico');
      if (fieldChecked('tg-m-cad-dom')) types.push('domicilio');
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'cad', enabled: fieldChecked('tg-m-cad-on'), panelUrl: fieldVal('tg-m-cad-url'), types: types }
      });
    } else if (kind === 'plans') {
      var planRows = [];
      var host = document.getElementById('tg-m-plans');
      if (host) {
        Array.prototype.forEach.call(host.children, function (row, i) {
          planRows.push({
            id: 'plan-' + (i + 1),
            name: (row.querySelector('[data-k="name"]') || {}).value || '',
            priceCop: Number((row.querySelector('[data-k="priceCop"]') || {}).value || 0),
            seats: (row.querySelector('[data-k="seats"]') || {}).value || '',
            text: (row.querySelector('[data-k="text"]') || {}).value || '',
            active: !!(row.querySelector('[data-k="active"]') || {}).checked
          });
        });
      }
      next = api('/public/portal/section', {
        method: 'PUT',
        body: { section: 'landingPlans', landingUrl: fieldVal('tg-m-landing-url'), landingPlans: planRows }
      });
    } else {
      return Promise.resolve();
    }
    return saveAccountIfNeeded(kind)
      .then(function () { return next; })
      .then(function (out) {
        if (out && out.company) state.company = out.company;
        if (out && out.connection) state.connection = out.connection;
        if (keepOpen === true) return out;
        closeToolModal();
        afterSave(out || {});
        return out;
      })
      .catch(onError);
  }

  function measureEnterpriseThreads() {
    var board = document.getElementById('tg-comp-board');
    var svg = document.getElementById('tg-threads');
    if (!board || !svg || window.matchMedia('(max-width: 900px)').matches) {
      if (svg) svg.innerHTML = '';
      return;
    }
    var box = board.getBoundingClientRect();
    if (box.width < 80 || box.height < 80) return;
    var cards = enterpriseCards(state.company || {}, state.connection || {});
    var active = {};
    cards.services.forEach(function (card) {
      if (card.active) active[card.kind] = true;
    });
    function anchor(kind, edge) {
      var slot = board.querySelector('[data-kind="' + kind + '"] .tg-comp');
      if (!slot) return null;
      var r = slot.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - box.left,
        y: edge === 'bottom' ? r.bottom - box.top : r.top - box.top
      };
    }
    var rows = CARD_THREADS.map(function (link) {
      return { link: link, a: anchor(link.from, 'bottom'), b: anchor(link.to, 'top') };
    }).filter(function (row) { return row.a && row.b; });
    var fromCount = {};
    var toCount = {};
    rows.forEach(function (row) {
      fromCount[row.link.from] = (fromCount[row.link.from] || 0) + 1;
      toCount[row.link.to] = (toCount[row.link.to] || 0) + 1;
    });
    var fromSeen = {};
    var toSeen = {};
    var parts = rows.map(function (row) {
      var fi = fromSeen[row.link.from] || 0;
      var ti = toSeen[row.link.to] || 0;
      fromSeen[row.link.from] = fi + 1;
      toSeen[row.link.to] = ti + 1;
      var x1 = row.a.x + (fi - (fromCount[row.link.from] - 1) / 2) * 8;
      var x2 = row.b.x + (ti - (toCount[row.link.to] - 1) / 2) * 8;
      var y1 = row.a.y;
      var y2 = row.b.y;
      var muted = !active[row.link.from];
      return (
        '<g><title>' + esc(row.link.label) + '</title>' +
        '<path d="M ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' L ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '"' +
        (muted ? ' class="is-idle"' : ' style="stroke:' + row.link.color + '"') + ' />' +
        '<circle cx="' + x1 + '" cy="' + y1 + '" r="3.5"' +
        (muted ? ' class="is-idle"' : ' style="fill:' + row.link.color + '"') + ' />' +
        '<circle cx="' + x2 + '" cy="' + y2 + '" r="3.5"' +
        (muted ? ' class="is-idle"' : ' style="fill:' + row.link.color + '"') + ' />' +
        '</g>'
      );
    }).join('');
    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    svg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
    svg.innerHTML = parts;
  }

  function bindEnterpriseBoard() {
    var board = document.getElementById('tg-comp-board');
    if (!board) return;
    board.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-open]');
      if (!btn) return;
      openToolModal(btn.getAttribute('data-open'));
    });
    measureEnterpriseThreads();
    if (!bindEnterpriseBoard.boundResize) {
      bindEnterpriseBoard.boundResize = true;
      window.addEventListener('resize', function () {
        measureEnterpriseThreads();
      });
    }
  }

  function wrapPane(id, html) {
    if (!html) return '';
    if (!isEnterprise()) return html;
    var on = (state.panelPane || 'mcp') === id;
    return '<div class="tg-pane' + (on ? ' is-on' : '') + '" data-pane="' + id + '">' + html + '</div>';
  }

  function enterpriseMenuHtml(c) {
    var items = [
      ['mcp', 'Componentes MCP'],
      ['brand', 'Marca del bot'],
      ['ai', 'Consumo de IA']
    ];
    if (geoUsageHtml(c)) items.push(['geo', 'Consumo Geoapify']);
    items.push(['chats', 'Conversaciones'], ['ctx', 'Contexto del bot']);
    return (
      '<nav class="tg-co__menu" aria-label="Secciones del panel">' +
      items.map(function (item) {
        var on = (state.panelPane || 'mcp') === item[0];
        return '<button type="button" class="tg-co__tab' + (on ? ' is-on' : '') + '" data-pane="' + item[0] + '">' + item[1] + '</button>';
      }).join('') +
      '</nav>'
    );
  }

  function bindEnterpriseMenu() {
    var menu = document.querySelector('.tg-co__menu');
    if (!menu) return;
    menu.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-pane]');
      if (!btn || !menu.contains(btn)) return;
      var id = btn.getAttribute('data-pane');
      state.panelPane = id;
      menu.querySelectorAll('.tg-co__tab').forEach(function (tab) {
        tab.classList.toggle('is-on', tab.getAttribute('data-pane') === id);
      });
      document.querySelectorAll('.tg-pane').forEach(function (pane) {
        pane.classList.toggle('is-on', pane.getAttribute('data-pane') === id);
      });
      if (id === 'mcp') measureEnterpriseThreads();
    });
  }

  function renderPanel() {
    var c = state.company;
    document.title = (c.name || 'Empresa') + ' · Bot WhatsApp IA';
    var conn = state.connection;
    var b = c.brand || {};
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<header class="tg-co__header">' +
      '<h1 class="tg-co__headline">' + companyHeadline(c) + '</h1>' +
      (isEnterprise() ? enterpriseMenuHtml(c) : '') +
      '<div class="tg-co__nav"><button type="button" class="tg-btn ghost" id="tg-logout">Salir</button></div>' +
      '</header>' +
      '<p class="tg-err tg-hidden" id="tg-err"></p>' +
      '<p class="tg-note tg-hidden" id="tg-note"></p>' +
      '<div class="tg-board">' +
      wrapPane('mcp', isEnterprise() ? toolsBoardHtml(c, conn) : '') +
      wrapPane('brand', '<section class="tg-panel tg-board__brand">' +
      '<div class="tg-panel__head"><h2>Marca del bot</h2>' +
      '<button type="button" class="tg-btn sm" id="tg-save-brand">Guardar marca</button></div>' +
      '<div class="tg-grid tg-grid--brand">' +
      '<label class="tg-field"><span>Nombre</span><input id="tg-b-name" value="' + esc(b.botName) + '" placeholder="Nombre del bot" /></label>' +
      '<label class="tg-field"><span>Tono</span><input id="tg-b-tone" value="' + esc(b.tone) + '" placeholder="Tono" /></label>' +
      '<label class="tg-field"><span>Idioma</span><input id="tg-b-lang" value="' + esc(b.language) + '" placeholder="es" /></label>' +
      '<label class="tg-field"><span>Horario</span><input id="tg-b-hours" value="' + esc(b.hours) + '" placeholder="Lun-Vie…" /></label>' +
      '<label class="tg-field tg-field--wide"><span>Disclaimer</span><input id="tg-b-disc" value="' + esc(b.disclaimer) + '" placeholder="Disclaimer" /></label>' +
      '</div></section>') +
      wrapPane('ai', aiUsageHtml(c.aiUsage)) +
      wrapPane('geo', geoUsageHtml(c)) +
      wrapPane('chats', chatsSectionHtml()) +
      wrapPane('ctx', '<section class="tg-panel tg-board__ctx">' +
      '<div class="tg-panel__head"><div><h2>Contexto del bot</h2>' +
      '<p class="tg-ctx__lead">Skill, capacidades y enlaces que usa el agente para responder.</p></div>' +
      '<button type="button" class="tg-btn sm" id="tg-save-ctx">Guardar contexto</button></div>' +
      '<div class="tg-ctx__row">' +
      '<div class="tg-ctx__block">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Skill negocio</h3><span class="tg-chip">markdown</span></div>' +
      skillLearnHtml() +
      '<textarea id="tg-skill" class="tg-area tg-area--fill"></textarea>' +
      '<div class="tg-float-kit">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Botón flotante</h3>' +
      '<button type="button" class="tg-btn ghost sm" id="tg-copy-float">Copiar HTML</button></div>' +
      '<p class="tg-muted">HTML y CSS del botón de WhatsApp de ' + esc(c.name || 'esta empresa') + '. Pégalo en la página.</p>' +
      '<textarea id="tg-float-html" class="tg-area tg-float-kit__code" rows="8" readonly></textarea></div></div>' +
      '<div class="tg-ctx__block">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Capacidades de producto</h3>' +
      '<span class="tg-chip">product-capabilities.json</span></div>' +
      '<textarea id="tg-caps" class="tg-area tg-area--fill" placeholder=\'{"capabilities":[]}\'></textarea></div>' +
      '</div>' +
      '<div class="tg-ctx__block tg-ctx__block--links">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>MCP · Link de pago</h3></div>' +
      '<div class="tg-grid tg-grid--links">' +
      '<label class="tg-field"><span>MCP URL (opcional)</span><input id="tg-mcp" placeholder="https://…/mcp" /></label>' +
      '<label class="tg-field"><span>Link de pago</span><input id="tg-pay" placeholder="https://checkout…" /></label>' +
      '</div></div></section>') +
      (isEnterprise() ? '' : '<section class="tg-panel tg-board__tutorial tg-tutorial">' +
      '<h2>Tutorial Meta Cloud API</h2>' +
      '<p class="tg-muted tg-tutorial__lead">Tu empresa configura Meta; el cluster es el <strong>webhook</strong> que recibe y responde.</p>' +
      '<ol class="tg-tutorial__steps">' +
      '<li><strong>App Meta</strong>' +
      '<a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">My Apps</a> → WhatsApp · ' +
      '<a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/" target="_blank" rel="noopener">Get started</a></li>' +
      '<li><strong>Número</strong>Phone Number ID + WABA · ' +
      '<a href="https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/" target="_blank" rel="noopener">docs</a></li>' +
      '<li><strong>Token permanente</strong>' +
      '<a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener">System Users</a></li>' +
      '<li><strong>Datos abajo</strong>App ID, Secret, WABA, Phone ID, token, Verify Token</li>' +
      '<li><strong>Webhook</strong>Callback = <code>' + esc((conn && conn.webhookUrl) || '…/wa/webhook') +
      '</code> · suscribe <code>messages</code></li>' +
      '<li><strong>Tarifas Meta</strong>' +
      '<a href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noopener">precios oficiales</a></li>' +
      '</ol>' +
      '</section>' +
      waSectionHtml(c, conn) +
      dropboxSectionHtml(c)) +
      /* Más adelante: Orquestador · RUNBOOK (OpenCode / Anomaly)
      '<section class="tg-panel tg-board__orch"><h2>RUNBOOK</h2>' +
      '<textarea class="tg-area tg-area--fill" id="tg-runbook" readonly></textarea></section>' +
      */
      '</div>';

    // textareas por valor, no por atributo, para no romper con < y &
    $('#tg-skill').value = (c.skills && c.skills[0] && c.skills[0].content) || '';
    var floatBox = $('#tg-float-html');
    if (floatBox) floatBox.value = floatPack(c, conn).html;
    $('#tg-caps').value = JSON.stringify(
      c.productCapabilities && typeof c.productCapabilities === 'object'
        ? c.productCapabilities
        : { capabilities: [] },
      null,
      2
    );
    $('#tg-mcp').value = (c.mcpServers && c.mcpServers[0] && c.mcpServers[0].url) || '';
    $('#tg-pay').value = (c.paymentLinks && c.paymentLinks[0] && c.paymentLinks[0].url) || '';
    // Más adelante: $('#tg-flows') / $('#tg-runbook')

    $('#tg-logout').addEventListener('click', function () {
      stopChatLive();
      saveToken('');
      state.token = '';
      state.conversations = [];
      state.selectedWaFrom = '';
      renderGate('');
    });
    $('#tg-save-brand').addEventListener('click', saveBrand);
    $('#tg-save-ctx').addEventListener('click', saveContext);
    var waBtn = $('#tg-save-wa');
    if (waBtn) waBtn.addEventListener('click', saveWa);
    var dbxBtn = $('#tg-save-dropbox');
    if (dbxBtn) dbxBtn.addEventListener('click', saveDropbox);
    bindCopy('#tg-copy-float', '#tg-float-html', 'HTML del botón flotante copiado');
    bindCopy('#tg-copy-webhook', '#tg-wa-webhook', 'Webhook copiado. Pégalo en «URL de devolución de llamada» en Meta');
    bindCopy('#tg-copy-verify', '#tg-wa-verify', 'Verify token copiado. Pégalo en el Paso 2 de developers.facebook.com');
    startChatLive();
    applyPlanLocks();
    mountP2lSupportChat();
    if (isEnterprise()) {
      bindEnterpriseBoard();
      bindEnterpriseMenu();
    }
  }

  function bindCopy(btnSel, inputSel, msg) {
    var btn = $(btnSel);
    var input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
      if (!input.value || !navigator.clipboard) return;
      navigator.clipboard.writeText(input.value).then(function () {
        flash('note', msg);
      });
    });
  }

  function flash(kind, msg) {
    var n = $('#tg-' + kind);
    if (!n) return;
    n.textContent = msg;
    n.classList.remove('tg-hidden');
    if (kind === 'note') setTimeout(function () { n.classList.add('tg-hidden'); }, 4000);
  }

  function afterSave(out) {
    if (out.company) state.company = out.company;
    if (out.connection) state.connection = out.connection;
    var keepFrom = state.selectedWaFrom;
    var keepRows = state.conversations.slice();
    renderPanel();
    state.selectedWaFrom = keepFrom;
    state.conversations = keepRows;
    renderChatPane();
    flash('note', 'Guardado');
  }

  function onError(e) {
    if (e.status === 401) {
      saveToken('');
      state.token = '';
      return renderGate('Tu sesión caducó. Vuelve a entrar con tu clave.');
    }
    flash('err', e.message || 'No se pudo guardar');
  }

  function saveBrand() {
    api('/public/portal/company', {
      method: 'PATCH',
      body: {
        brand: {
          botName: $('#tg-b-name').value.trim(),
          tone: $('#tg-b-tone').value.trim(),
          language: $('#tg-b-lang').value.trim(),
          hours: $('#tg-b-hours').value.trim(),
          disclaimer: $('#tg-b-disc').value.trim()
        }
      }
    }).then(afterSave).catch(onError);
  }

  function saveContext() {
    if (!planOn('skill') && !planOn('capabilities')) return;
    var productCapabilities;
    // Más adelante: editar flujos en UI. Hoy se preservan desde state.company.
    var flows = Array.isArray(state.company && state.company.flows) ? state.company.flows : [];
    try {
      productCapabilities = JSON.parse($('#tg-caps').value || '{"capabilities":[]}');
      if (!productCapabilities || typeof productCapabilities !== 'object' || Array.isArray(productCapabilities)) {
        throw new Error('debe ser un objeto con capabilities[]');
      }
      if (!Array.isArray(productCapabilities.capabilities)) {
        throw new Error('falta capabilities[]');
      }
    } catch (e) {
      return flash('err', 'Capacidades JSON inválido: ' + e.message);
    }
    var mcp = $('#tg-mcp').value.trim();
    var pay = $('#tg-pay').value.trim();
    var body = { flows: flows };
    if (planOn('skill')) body.skills = [{ path: 'negocio.md', content: $('#tg-skill').value }];
    if (planOn('capabilities')) {
      body.productCapabilities = productCapabilities;
      body.mcpServers = mcp ? [{ name: 'mcp', type: 'sse', url: mcp }] : [];
      body.paymentLinks = pay ? [{ label: 'Pago', url: pay }] : [];
    }
    api('/public/portal/company', {
      method: 'PATCH',
      body: body
    }).then(afterSave).catch(onError);
  }

  function saveDropbox() {
    if (!planOn('dropbox')) return flash('err', 'Tu plan no incluye Dropbox.');
    var body = {
      dropboxAppKey: $('#tg-dbx-key').value.trim(),
      dropboxAppFolder: $('#tg-dbx-folder').value.trim()
    };
    var secret = $('#tg-dbx-secret').value.trim();
    var refresh = $('#tg-dbx-refresh').value.trim();
    if (secret) body.dropboxAppSecret = secret;
    if (refresh) body.dropboxRefreshToken = refresh;
    api('/public/portal/dropbox', { method: 'PUT', body: body })
      .then(afterSave)
      .catch(onError);
  }

  function saveWa() {
    if (!planOn('whatsapp')) return flash('err', 'Tu plan no incluye WhatsApp.');
    var body = {
      metaAppId: $('#tg-wa-app').value.trim(),
      wabaId: $('#tg-wa-waba').value.trim(),
      phoneNumberId: $('#tg-wa-phone').value.trim(),
      displayPhone: $('#tg-wa-display').value.trim(),
      verifyToken: $('#tg-wa-verify').value.trim()
    };
    var secret = $('#tg-wa-secret').value.trim();
    var token = $('#tg-wa-token').value.trim();
    if (secret) body.appSecret = secret;
    if (token) body.accessToken = token;
    api('/public/portal/connection', { method: 'PUT', body: body })
      .then(afterSave)
      .catch(onError);
  }

  /* ── chat de soporte P2L (mismo canal chatMessage del Semantic IDE) ── */

  var P2L_SUPPORT_TO = 'jaalza@gmail.com';
  var p2lSupportRows = [];
  var p2lSupportOpen = false;
  var p2lSupportUnread = 0;

  function p2lSupportMe() {
    return 'tg-portal-' + (state.companyId || '');
  }

  function p2lSupportRoom() {
    return 'direct-' + [p2lSupportMe(), P2L_SUPPORT_TO].sort().join('_');
  }

  function devopsChatEnabled() {
    if (isEnterprise()) return true;
    var caps = state.company && state.company.planSpec && state.company.planSpec.agentCapabilities;
    return !!(caps && caps.devopsChat === true);
  }

  function p2lSupportStoreKey() {
    return 'p2l-support-chat-' + (state.companyId || 'x');
  }

  function loadP2lSupportRows() {
    try {
      var raw = sessionStorage.getItem(p2lSupportStoreKey());
      var parsed = raw ? JSON.parse(raw) : [];
      p2lSupportRows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      p2lSupportRows = [];
    }
  }

  function saveP2lSupportRows() {
    try {
      var slim = p2lSupportRows.slice(-80).map(function (r) {
        return { id: r.id, text: r.text, mine: !!r.mine };
      });
      sessionStorage.setItem(p2lSupportStoreKey(), JSON.stringify(slim));
    } catch (e) {}
  }

  function flushP2lSupport() {
    if (!chatSocket || !chatSocket.connected) return;
    p2lSupportRows.forEach(function (row) {
      if (!row.pending || !row.payload) return;
      chatSocket.emit('chatMessage', row.payload);
      row.pending = false;
      row.payload = null;
    });
  }

  function mountP2lSupportChat(force) {
    var oldFab = document.getElementById('p2l-support-fab');
    var oldBox = document.getElementById('p2l-support-box');
    if (force === false) {
      if (oldFab) oldFab.remove();
      if (oldBox) oldBox.remove();
      p2lSupportOpen = false;
      return;
    }
    var on = devopsChatEnabled();
    if (!on && oldBox) oldBox.remove();
    if (!on) p2lSupportOpen = false;
    if (oldFab) oldFab.remove();
    if (on && !p2lSupportRows.length) loadP2lSupportRows();
    var fab = document.createElement('button');
    fab.id = 'p2l-support-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Chat de soporte P2L');
    fab.innerHTML = '<span class="p2l-support-fab__mark">P2L</span><span>Soporte</span>';
    if (!on) {
      fab.className = 'is-locked';
      fab.setAttribute('aria-disabled', 'true');
      fab.title = 'Contrata Soporte Devops P2L Chat para activar este chat';
    } else {
      fab.title = 'Chat de soporte P2L';
      fab.addEventListener('click', function () {
        p2lSupportOpen = !p2lSupportOpen;
        p2lSupportUnread = 0;
        renderP2lSupport();
      });
    }
    document.body.appendChild(fab);
    if (on) renderP2lSupport();
  }

  function renderP2lSupport() {
    var fab = document.getElementById('p2l-support-fab');
    if (fab) fab.classList.toggle('has-unread', p2lSupportUnread > 0 && !p2lSupportOpen);
    var box = document.getElementById('p2l-support-box');
    if (!p2lSupportOpen) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('section');
      box.id = 'p2l-support-box';
      box.className = 'p2l-support';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Chat de soporte P2L');
      document.body.appendChild(box);
    }
    var company = (state.company && state.company.name) || 'tu empresa';
    var rows = p2lSupportRows.map(function (m) {
      return '<div class="p2l-support__row ' + (m.mine ? 'is-mine' : 'is-theirs') + '"><p>' + esc(m.text) + '</p></div>';
    }).join('');
    box.innerHTML =
      '<header class="p2l-support__head"><div><strong>Soporte P2L</strong><span>Devops · ' + esc(company) + '</span></div>' +
      '<button type="button" id="p2l-support-close" aria-label="Cerrar">×</button></header>' +
      '<div class="p2l-support__log" id="p2l-support-log">' +
      (rows || '<p class="p2l-support__empty">Escribe a soporte P2L. La respuesta llega por el mismo chat del Semantic IDE.</p>') +
      '</div>' +
      '<form class="p2l-support__form" id="p2l-support-form">' +
      '<input id="p2l-support-input" maxlength="2000" placeholder="Mensaje para soporte P2L" autocomplete="off" />' +
      '<button type="submit">Enviar</button></form>';
    var log = document.getElementById('p2l-support-log');
    if (log) log.scrollTop = log.scrollHeight;
    document.getElementById('p2l-support-close').addEventListener('click', function () {
      p2lSupportOpen = false;
      renderP2lSupport();
    });
    document.getElementById('p2l-support-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = document.getElementById('p2l-support-input');
      var text = input && input.value ? input.value.trim() : '';
      if (!text) return;
      sendP2lSupport(text);
      input.value = '';
    });
    var input = document.getElementById('p2l-support-input');
    if (input) input.focus();
  }

  function sendP2lSupport(text) {
    var me = p2lSupportMe();
    var room = p2lSupportRoom();
    var company = (state.company && state.company.name) || 'Empresa';
    var message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      text: text,
      from: me,
      to: P2L_SUPPORT_TO,
      fromName: company,
      fromProfile: 'techguard-wa-portal',
      chatId: room,
      roomId: room,
      timestamp: new Date().toISOString()
    };
    var payload = {
      message: message,
      from: me,
      to: P2L_SUPPORT_TO,
      text: text,
      chatId: room,
      roomId: room
    };
    var row = { id: message.id, text: text, mine: true, pending: true, payload: payload };
    p2lSupportRows.push(row);
    saveP2lSupportRows();
    renderP2lSupport();
    flushP2lSupport();
  }

  function onP2lSupportMessage(data) {
    if (!devopsChatEnabled()) return;
    var msg = (data && data.message) || data || {};
    var me = p2lSupportMe();
    var from = String(msg.from || (data && data.from) || '');
    var to = String(msg.to || (data && data.to) || '');
    if (!from || from === me) return;
    if (to && to !== me) return;
    var text = String(msg.text || '').trim();
    if (!text) return;
    if (msg.id && p2lSupportRows.some(function (row) { return row.id === msg.id; })) return;
    p2lSupportRows.push({ id: msg.id || ('in_' + Date.now()), text: text, mine: false });
    saveP2lSupportRows();
    if (!p2lSupportOpen) p2lSupportUnread += 1;
    if (document.getElementById('p2l-support-fab')) renderP2lSupport();
  }

  /* ── arranque ────────────────────────────────────────────────────────── */

  function boot() {
    mountP2lSupportChat(false);
    state.companyId = readCompanyId();
    if (!state.companyId) {
      $('#tg-root').className = 'tg-co';
      $('#tg-root').innerHTML =
        '<div class="tg-gate"><div class="tg-gate__card">' +
        '<p class="tg-gate__brand">P2L</p>' +
        '<p class="tg-gate__eyebrow">Panel de empresa</p>' +
        '<p class="tg-gate__lead">Este enlace no trae el identificador de tu empresa. ' +
        'Abre el enlace completo que te envió el cluster.</p></div></div>';
      return;
    }
    state.token = loadToken();
    if (!state.token) return renderGate('');
    $('#tg-root').innerHTML = '<p class="tg-loading">Cargando tu panel…</p>';
    api('/public/portal/session')
      .then(function (out) {
        state.company = out.company;
        state.connection = out.connection;
        renderPanel();
      })
      .catch(function () {
        saveToken('');
        state.token = '';
        renderGate('');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
