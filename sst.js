(function () {
  'use strict';
  var CFG = window.SAUVIA_CONFIG;
  var app = document.getElementById('app');
  var S = { session: null, profile: null, accidents: [], zones: {}, guides: [], view: 'list', filter: 'todo', openId: null, detail: null, photos: [], busy: false, msg: '' };

  // ---------- utilitaires ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) {
      var v = attrs[k];
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function fmt(d) { return d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  var STATUS = {
    a_prendre_en_charge: ['À prendre en charge', 'b-todo'], en_attente_visa: ['En attente de visa', 'b-visa'], a_qualifier: ['À qualifier', 'b-qual'],
    inscrit_registre: ['Inscrit au registre', 'b-reg'], dat_a_envoyer: ['DAT à envoyer', 'b-dat'], clos: ['Clos', 'b-clos']
  };
  var SEV = { benin: 'Bénin', soins: 'Soins nécessaires', grave: 'Grave', vital: 'Urgence vitale' };

  // ---------- API ----------
  function loadSession() { S.session = lsGet('sauvia.sst.session', null); }
  function saveSession(s) { S.session = s; lsSet('sauvia.sst.session', s); }
  function authHeaders(extra) {
    var h2 = { apikey: CFG.anonKey, Authorization: 'Bearer ' + (S.session ? S.session.access_token : CFG.anonKey) };
    for (var k in (extra || {})) h2[k] = extra[k];
    return h2;
  }
  function tokenReq(grant, body) {
    return fetch(CFG.url + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); });
  }
  function toSession(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user_id: j.user && j.user.id }; }
  var refreshing = null;
  function ensureFresh() {
    if (!S.session) return Promise.reject(new Error('auth'));
    if (S.session.expires_at - Date.now() > 60000) return Promise.resolve();
    if (!navigator.onLine) return Promise.resolve();
    if (!refreshing) refreshing = tokenReq('refresh_token', { refresh_token: S.session.refresh_token }).then(function (r) {
      refreshing = null;
      if (r.ok) { var s = toSession(r.j); s.user_id = s.user_id || S.session.user_id; saveSession(s); return; }
      if (r.status === 400 || r.status === 401 || r.status === 403) { saveSession(null); throw new Error('auth'); }
    }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  function api(path, opts) {
    opts = opts || {};
    return ensureFresh().then(function () {
      return fetch(CFG.url + path, { method: opts.method || 'GET', headers: authHeaders(opts.headers), body: opts.body ? JSON.stringify(opts.body) : undefined });
    }).then(function (r) {
      if (r.status === 401) { var e = new Error('auth'); e.auth = true; throw e; }
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (x) {}
        if (!r.ok) { var er = new Error((j && (j.message || j.error)) || ('http_' + r.status)); er.http = r.status; throw er; }
        return j;
      });
    });
  }

  // ---------- connexion ----------
  function login(email, pass) {
    return tokenReq('password', { email: email, password: pass }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 400 ? 'bad' : 'net');
      saveSession(toSession(r.j));
    });
  }
  function logout() { saveSession(null); S.profile = null; S.accidents = []; render(); }

  function loadProfile() {
    return api('/rest/v1/profiles?user_id=eq.' + S.session.user_id + '&select=full_name,role,company_id,site_id,is_on_call,is_active').then(function (rows) {
      var p = rows && rows[0];
      if (!p || !p.is_active) throw new Error('noprofile');
      S.profile = p; lsSet('sauvia.sst.profile', p);
    });
  }

  // ---------- file d'attente d'envoi ----------
  function queue() { return lsGet('sauvia.sst.patches', {}); }
  function saveQueue(q) { lsSet('sauvia.sst.patches', q); showQueued(); }
  function showQueued() {
    var n = Object.keys(queue()).length, el = document.getElementById('queued');
    el.hidden = n === 0;
    if (n) el.textContent = n + (n > 1 ? ' fiches modifiées en attente d\'envoi.' : ' fiche modifiée en attente d\'envoi.');
  }
  function enqueue(id, fields) {
    var q = queue(); q[id] = Object.assign(q[id] || {}, fields); saveQueue(q);
    if (S.detail && S.detail.id === id) Object.assign(S.detail, fields);
    flush();
  }
  var flushing = false;
  function flush() {
    if (flushing || !navigator.onLine || !S.session) return Promise.resolve();
    var q = queue(), ids = Object.keys(q);
    if (!ids.length) return Promise.resolve();
    flushing = true;
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var fields = Object.assign({}, q[id]);
        return api('/rest/v1/accidents?id=eq.' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: fields }).then(function (rows) {
          var cur = queue();
          // on ne retire que ce qui a été envoyé (des modifications ont pu arriver pendant l'envoi)
          if (cur[id]) { Object.keys(fields).forEach(function (k) { if (JSON.stringify(cur[id][k]) === JSON.stringify(fields[k])) delete cur[id][k]; }); if (!Object.keys(cur[id]).length) delete cur[id]; }
          saveQueue(cur);
          if (!rows || !rows.length) { S.msg = 'Une fiche n\'a pas pu être modifiée (verrouillée ou non autorisée).'; }
          else if (S.detail && S.detail.id === id) { S.detail = Object.assign(S.detail, rows[0], queue()[id] || {}); }
        });
      });
    });
    return chain.catch(function (e) {
      if (e && e.http && e.http >= 400 && e.http < 500 && !e.auth) { S.msg = 'Modification refusée : ' + e.message; var cur = queue(); saveQueue(cur); }
    }).then(function () { flushing = false; if (S.view === 'detail') render(); });
  }

  // ---------- chargement ----------
  function loadGuides() {
    return api('/rest/v1/care_guides?select=slug,title,content&is_published=eq.true&order=title').then(function (g) { S.guides = g || []; lsSet('sauvia.sst.guides', S.guides); })
      .catch(function () { S.guides = lsGet('sauvia.sst.guides', []); });
  }
  function loadList() {
    var cols = 'id,site_id,zone_id,victim_name,worker_status,occurred_at,created_at,status,severity,location_detail,circumstances';
    return Promise.all([
      api('/rest/v1/accidents?select=' + cols + '&order=created_at.desc&limit=150'),
      api('/rest/v1/zones?select=id,name')
    ]).then(function (r) {
      S.accidents = r[0] || []; S.zones = {}; (r[1] || []).forEach(function (z) { S.zones[z.id] = z.name; });
      lsSet('sauvia.sst.list', { accidents: S.accidents, zones: S.zones });
    }).catch(function (e) {
      if (e.auth || e.message === 'auth') throw e;
      var c = lsGet('sauvia.sst.list', null); if (c) { S.accidents = c.accidents; S.zones = c.zones; }
    });
  }
  function openAccident(id) {
    S.openId = id; S.view = 'detail'; S.detail = null; S.photos = []; S.msg = ''; render();
    api('/rest/v1/accidents?id=eq.' + id + '&select=*').then(function (rows) {
      if (!rows || !rows[0]) throw new Error('nf');
      S.detail = Object.assign(rows[0], queue()[id] || {}); lsSet('sauvia.sst.acc.' + id, S.detail);
    }).catch(function (e) {
      if (e.auth || e.message === 'auth') { logout(); return; }
      var c = lsGet('sauvia.sst.acc.' + id, null);
      if (c) S.detail = Object.assign(c, queue()[id] || {});
      else { var l = S.accidents.filter(function (a) { return a.id === id; })[0]; if (l) S.detail = Object.assign({}, l, queue()[id] || {}, { _partial: true }); }
    }).then(function () {
      render();
      if (!S.detail) return;
      return api('/rest/v1/accident_attachments?accident_id=eq.' + id + '&select=storage_path').then(function (rows) {
        return Promise.all((rows || []).map(function (a) {
          return api('/storage/v1/object/sign/' + CFG.bucket + '/' + a.storage_path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { expiresIn: 600 } })
            .then(function (j) { return CFG.url + '/storage/v1' + j.signedURL; }).catch(function () { return null; });
        }));
      }).then(function (urls) { S.photos = (urls || []).filter(Boolean); if (S.view === 'detail' && S.openId === id) render(); }).catch(function () {});
    });
  }

  // ---------- vues ----------
  function render() {
    document.getElementById('who').textContent = S.profile ? S.profile.full_name || '' : '';
    app.textContent = '';
    window.scrollTo(0, 0);
    if (!S.session || !S.profile) return app.appendChild(viewLogin());
    app.appendChild(S.view === 'detail' ? viewDetail() : viewList());
  }

  function viewLogin() {
    var msg = h('p', { class: 'error', role: 'alert', hidden: true });
    var email = h('input', { id: 'em', type: 'text', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none' });
    var pass = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password' });
    pass.style.letterSpacing = 'normal'; pass.style.fontSize = '16px'; pass.style.textAlign = 'left';
    var btn = h('button', { type: 'submit', class: 'primary', text: 'Se connecter' });
    var f = h('form', { novalidate: true, onsubmit: function (ev) {
      ev.preventDefault(); msg.hidden = true; btn.disabled = true;
      login(email.value.trim(), pass.value).then(loadProfile).then(function () { return Promise.all([loadGuides(), loadList()]); }).then(function () { S.view = 'list'; render(); startPolling(); })
        .catch(function (e) {
          btn.disabled = false; saveSession(null);
          msg.textContent = e.message === 'bad' ? 'E-mail ou mot de passe incorrect.' : e.message === 'noprofile' ? 'Ce compte n\'est pas autorisé sur Sauvia.' : 'Connexion impossible pour le moment.'; msg.hidden = false;
        });
    } },
      h('div', { class: 'field' }, h('label', { for: 'em', text: 'Adresse e-mail' }), email),
      h('div', { class: 'field' }, h('label', { for: 'pw', text: 'Mot de passe' }), pass), msg, btn);
    return h('section', null, h('h1', { text: 'Espace SST' }), h('p', { class: 'lead', text: 'Connectez-vous pour prendre en charge les accidents de votre entreprise.' }), f);
  }

  function viewList() {
    var filters = [['todo', 'À traiter'], ['all', 'Tous']];
    var tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filtre' });
    filters.forEach(function (f) { tabs.appendChild(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.filter === f[0]), text: f[1], onclick: function () { S.filter = f[0]; render(); } })); });
    var list = S.accidents.filter(function (a) { return S.filter === 'all' || a.status === 'a_prendre_en_charge' || a.status === 'en_attente_visa'; });
    var box = h('div');
    if (!list.length) box.appendChild(h('p', { class: 'lead', text: S.filter === 'todo' ? 'Aucun accident à traiter.' : 'Aucun accident.' }));
    list.forEach(function (a) {
      var st = STATUS[a.status] || [a.status, 'b-clos'];
      box.appendChild(h('button', { type: 'button', class: 'card', onclick: function () { openAccident(a.id); } },
        h('div', { class: 'row' }, h('h3', { text: a.victim_name }), h('span', { class: 'badge ' + st[1], text: st[0] })),
        h('p', { text: fmt(a.occurred_at) + ' · ' + (S.zones[a.zone_id] || 'Zone non précisée') + (a.worker_status === 'interimaire' ? ' · Intérimaire' : '') }),
        h('p', { text: a.circumstances.length > 90 ? a.circumstances.slice(0, 90) + '…' : a.circumstances })));
    });
    return h('section', null,
      h('div', { class: 'row' }, h('h1', { text: 'Accidents' }), h('button', { type: 'button', class: 'back', text: 'Déconnexion', onclick: logout })),
      tabs, S.msg ? h('p', { class: 'error', role: 'alert', text: S.msg }) : null, box, alertSettings());
  }

  function guideBySlug(slug) { return S.guides.filter(function (g) { return g.slug === slug; })[0]; }

  function viewDetail() {
    var a = S.detail;
    var back = h('button', { type: 'button', class: 'back', text: '← Retour à la liste', onclick: function () { S.view = 'list'; S.detail = null; loadList().then(render).catch(function () {}); render(); } });
    if (!a) return h('section', null, back, h('p', { class: 'lead', text: 'Chargement…' }));
    var locked = !!a.sst_visa_at;
    var st = STATUS[a.status] || [a.status, 'b-clos'];
    var sec = h('section', null, back,
      h('div', { class: 'row' }, h('h1', { text: a.victim_name }), h('span', { class: 'badge ' + st[1], text: st[0] })),
      S.msg ? h('p', { class: 'error', role: 'alert', text: S.msg }) : null);

    var info = h('dl', { class: 'kv' },
      h('dt', { text: 'Quand' }), h('dd', { text: fmt(a.occurred_at) }),
      h('dt', { text: 'Où' }), h('dd', { text: (S.zones[a.zone_id] || 'Zone non précisée') + (a.location_detail ? ' – ' + a.location_detail : '') }),
      h('dt', { text: 'Statut' }), h('dd', { text: a.worker_status === 'interimaire' ? 'Intérimaire (déclaration d\'accident du travail)' : 'Salarié' }),
      h('dt', { text: 'Récit' }), h('dd', { text: a.circumstances }));
    var box = h('div', { class: 'sect' }, h('h2', { text: 'Signalement' }), info);
    if (S.photos.length) { var ph = h('div', { class: 'photos' }); S.photos.forEach(function (u) { ph.appendChild(h('img', { src: u, alt: 'Photo jointe au signalement' })); }); box.appendChild(ph); }
    sec.appendChild(box);

    if (locked) sec.appendChild(h('p', { class: 'locked', text: 'Visa donné le ' + fmt(a.sst_visa_at) + '. Le contenu des soins est figé.' }));

    // Alerte renfort
    if (!locked) sec.appendChild(alertBlock(a));

    // Conduite à tenir
    sec.appendChild(careBlock(a, locked));
    sec.appendChild(detailsBlock(a, locked));
    if (!locked) sec.appendChild(visaBlock(a));
    return sec;
  }

  function alertBlock(a) {
    var level = h('select', { id: 'alvl', class: 'sm' }, h('option', { value: 'renfort', text: 'Renfort demandé' }), h('option', { value: 'urgence_vitale', text: 'Urgence vitale' }));
    var msg = h('input', { type: 'text', class: 'sm', placeholder: 'Ex. besoin d\'un second SST', maxlength: 300, 'aria-label': 'Message pour les renforts' });
    var out = h('p', { class: 'small', role: 'status' });
    var btn = h('button', { type: 'button', class: 'primary btn-red', text: 'Alerter un renfort', onclick: function () {
      if (!navigator.onLine) { out.textContent = 'Pas de réseau : appelez directement un autre SST ou le 15 · 18 · 112.'; return; }
      btn.disabled = true;
      api('/rest/v1/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: {
        company_id: a.company_id || S.profile.company_id, site_id: a.site_id, accident_id: a.id, level: level.value,
        zone_label: S.zones[a.zone_id] || a.location_detail || 'Lieu à préciser', message: msg.value.trim() || a.victim_name, sent_by: S.session.user_id } })
        .then(function () { out.textContent = 'Alerte envoyée aux SST du site et aux responsables.'; btn.disabled = false; })
        .catch(function () { out.textContent = 'Alerte non envoyée. Appelez directement un autre SST.'; btn.disabled = false; });
    } });
    return h('div', { class: 'sect' }, h('h2', { text: 'Alerte renfort' }), h('div', { class: 'field' }, level), h('div', { class: 'field' }, msg), btn, out,
      h('p', { class: 'small', text: 'Cette alerte interne est un complément non garanti. Elle ne remplace pas les secours.' }));
  }

  function careBlock(a, locked) {
    var wrap = h('div', { class: 'sect' }, h('h2', { text: 'Conduite à tenir' }));
    var actions = Array.isArray(a.care_actions) ? a.care_actions : [];
    var done = {}; actions.forEach(function (x) { done[x.s] = true; });
    var sel = h('select', { id: 'guide', class: 'sm', 'aria-label': 'Choisir une fiche' }, h('option', { value: '', text: 'Choisir une fiche…' }));
    S.guides.forEach(function (g) { sel.appendChild(h('option', { value: g.slug, text: g.title })); });
    var box = h('div');
    function showGuide(slug) {
      box.textContent = '';
      var g = guideBySlug(slug); if (!g) return;
      box.appendChild(h('p', { class: 'alertline', text: 'Alerte : ' + g.content.alerte }));
      g.content.sections.forEach(function (s) {
        box.appendChild(h('h3', { text: s.title, style: 'font-size:15px;margin:12px 0 6px' }));
        var ul = h('ul', { class: 'steps' });
        s.steps.forEach(function (st) {
          var cb = h('input', { type: 'checkbox', disabled: locked, checked: !!done[st.id], onchange: function () {
            var cur = (S.detail.care_actions || []).filter(function (x) { return x.s !== st.id; });
            if (cb.checked) cur.push({ g: g.slug, s: st.id, t: new Date().toISOString() });
            var titles = []; cur.forEach(function (x) { var gg = guideBySlug(x.g); if (gg && titles.indexOf(gg.title) < 0) titles.push(gg.title); });
            enqueue(a.id, { care_actions: cur, care_situation: titles.join(' ; ') });
          } });
          ul.appendChild(h('li', null, h('label', null, cb, h('span', { text: st.text }))));
        });
        box.appendChild(ul);
      });
    }
    sel.addEventListener('change', function () { showGuide(sel.value); });
    var used = actions.length ? (guideBySlug(actions[actions.length - 1].g) ? actions[actions.length - 1].g : '') : '';
    if (used) { sel.value = used; showGuide(used); }
    if (!S.guides.length) wrap.appendChild(h('p', { class: 'small', text: 'Aucune fiche disponible (ouvrez l\'application une fois avec du réseau).' }));
    wrap.appendChild(h('div', { class: 'field' }, sel)); wrap.appendChild(box);
    wrap.appendChild(h('p', { class: 'small', text: actions.length + ' geste(s) coché(s). Ces fiches guident l\'intervention ; elles ne remplacent ni la formation SST ni les consignes des secours.' }));
    return wrap;
  }

  function detailsBlock(a, locked) {
    var sev = h('select', { id: 'sev', class: 'sm', disabled: locked, onchange: function () { enqueue(a.id, { severity: sev.value || null }); } }, h('option', { value: '', text: 'Choisir…' }));
    Object.keys(SEV).forEach(function (k) { sev.appendChild(h('option', { value: k, text: SEV[k], selected: a.severity === k })); });
    function txt(id, label, key, ph) {
      var i = h('input', { id: id, type: 'text', class: 'sm', maxlength: 200, disabled: locked, placeholder: ph, value: a[key] || '', onchange: function () { var o = {}; o[key] = i.value.trim() || null; enqueue(a.id, o); } });
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), i);
    }
    function chk(label, key, extra) {
      var c = h('input', { type: 'checkbox', disabled: locked, checked: !!a[key], onchange: function () { var o = {}; o[key] = c.checked; if (key === 'rescue_called') o.rescue_called_at = c.checked ? new Date().toISOString() : null; enqueue(a.id, o); } });
      return h('label', { class: 'check' }, c, h('span', { text: label }));
    }
    var notes = h('textarea', { id: 'notes', rows: 3, maxlength: 2000, disabled: locked, value: a.care_notes || '', onchange: function () { enqueue(a.id, { care_notes: notes.value.trim() || null }); } });
    notes.value = a.care_notes || '';
    return h('div', { class: 'sect' }, h('h2', { text: 'Soins donnés' }),
      h('div', { class: 'field' }, h('label', { for: 'sev', text: 'Gravité' }), sev),
      txt('inat', 'Nature de la lésion', 'injury_nature', 'Ex. coupure, brûlure, entorse'),
      txt('isite', 'Siège de la lésion', 'injury_site', 'Ex. main droite'),
      chk('Les secours ont été appelés (15 · 18 · 112)', 'rescue_called'),
      txt('rsv', 'Service contacté', 'rescue_service', 'Ex. SAMU, pompiers'),
      chk('La personne a été évacuée', 'evacuated'),
      h('div', { class: 'field' }, h('label', { for: 'notes', text: 'Remarques' }), notes));
  }

  // ---------- visa et signatures ----------
  function sigPad(label) {
    var c = h('canvas', { class: 'sigbox', width: 600, height: 280, 'aria-label': label });
    var ctx = c.getContext('2d'), drawing = false, has = false;
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = '#1A2330';
    function pos(e) { var r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; }
    c.addEventListener('pointerdown', function (e) { drawing = true; c.setPointerCapture(e.pointerId); var p = pos(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]); e.preventDefault(); });
    c.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); has = true; e.preventDefault(); });
    ['pointerup', 'pointercancel'].forEach(function (n) { c.addEventListener(n, function () { drawing = false; }); });
    return { el: c, isEmpty: function () { return !has; }, clear: function () { ctx.clearRect(0, 0, c.width, c.height); has = false; }, data: function () { return c.toDataURL('image/png'); } };
  }
  function visaBlock(a) {
    var sst = sigPad('Signature du SST'), vic = sigPad('Signature de la victime');
    var absent = h('input', { type: 'checkbox', id: 'absent' });
    var reason = h('input', { type: 'text', class: 'sm', maxlength: 200, placeholder: 'Motif (ex. évacuée par les secours)', hidden: true, 'aria-label': 'Motif de l\'absence de signature' });
    absent.addEventListener('change', function () { reason.hidden = !absent.checked; vic.el.hidden = absent.checked; });
    var err = h('p', { class: 'error', role: 'alert', hidden: true });
    var btn = h('button', { type: 'button', class: 'primary', text: 'Viser et verrouiller les soins', onclick: function () {
      var d = S.detail, problems = [];
      if (!d.severity) problems.push('la gravité');
      if (!(d.care_actions && d.care_actions.length) && !(d.care_notes)) problems.push('au moins un geste ou une remarque');
      if (sst.isEmpty()) problems.push('votre signature');
      if (absent.checked ? !reason.value.trim() : vic.isEmpty()) problems.push(absent.checked ? 'le motif de l\'absence de signature' : 'la signature de la victime');
      if (problems.length) { err.textContent = 'À compléter : ' + problems.join(', ') + '.'; err.hidden = false; return; }
      if (!confirm('Après le visa, le contenu des soins ne pourra plus être modifié (seulement corrigé par additif). Confirmer ?')) return;
      err.hidden = true;
      var f = { sst_visa_at: new Date().toISOString(), sst_signature: sst.data() };
      if (absent.checked) f.victim_signature_absent_reason = reason.value.trim(); else { f.victim_signature = vic.data(); f.victim_signed_at = f.sst_visa_at; }
      enqueue(a.id, f); render();
    } });
    return h('div', { class: 'sect' }, h('h2', { text: 'Visa du donneur de soins' }),
      h('p', { class: 'small', text: 'Le visa et la signature de la victime sont requis pour l\'inscription éventuelle au registre.' }),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Signature du SST' }), sst.el, h('button', { type: 'button', class: 'ghost small', text: 'Effacer', onclick: sst.clear })),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Signature de la victime' }), vic.el, h('button', { type: 'button', class: 'ghost small', text: 'Effacer', onclick: vic.clear }),
        h('label', { class: 'check', for: 'absent' }, absent, h('span', { text: 'La victime ne peut pas signer' })), reason),
      err, btn);
  }


  // ---------- réception des alertes ----------
  var AL = { shown: null, timer: null, ctx: null, osc: null, lock: null, dismissed: lsGet('sauvia.sst.dismissed', {}), push: 'unknown' };
  function b64u(str) { var p = '='.repeat((4 - str.length % 4) % 4), b = (str + p).replace(/-/g, '+').replace(/_/g, '/'), raw = atob(b), a = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function pushState() {
    if (!pushSupported()) { AL.push = 'unsupported'; return Promise.resolve(); }
    if (Notification.permission === 'denied') { AL.push = 'denied'; return Promise.resolve(); }
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { AL.push = sub && Notification.permission === 'granted' ? 'on' : 'off'; }).catch(function () { AL.push = 'off'; });
  }
  function unlockAudio() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      if (!AL.ctx) AL.ctx = new C();
      if (AL.ctx.state === 'suspended') AL.ctx.resume();
    } catch (e) {}
  }
  function beepOnce(freq, dur) {
    if (!AL.ctx) return;
    try {
      var o = AL.ctx.createOscillator(), g = AL.ctx.createGain();
      o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.25;
      o.connect(g); g.connect(AL.ctx.destination); o.start(); o.stop(AL.ctx.currentTime + dur);
    } catch (e) {}
  }
  function startAlarm(urgent) {
    stopAlarm();
    var n = 0;
    function tick() {
      if (urgent) { beepOnce(n % 2 ? 660 : 880, 0.35); if (navigator.vibrate) navigator.vibrate([400, 150, 400]); }
      else if (n === 0) { beepOnce(660, 0.2); if (navigator.vibrate) navigator.vibrate(200); }
      n++;
    }
    tick(); if (urgent) AL.timer = setInterval(tick, 900);
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { AL.lock = l; }, function () {}); } catch (e) {}
  }
  function stopAlarm() {
    if (AL.timer) { clearInterval(AL.timer); AL.timer = null; }
    if (navigator.vibrate) navigator.vibrate(0);
    if (AL.lock) { try { AL.lock.release(); } catch (e) {} AL.lock = null; }
  }
  function closeOverlay() {
    stopAlarm(); AL.shown = null;
    var o = document.getElementById('alarm'); if (o) o.remove();
  }
  function respond(rec, response) {
    return api('/rest/v1/alert_recipients?id=eq.' + rec.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: { response: response, responded_at: new Date().toISOString() } });
  }
  function showAlarm(rec) {
    var al = rec.alerts || {}, urgent = rec.kind === 'urgence', vital = al.level === 'urgence_vitale';
    if (AL.shown === rec.id) return;
    closeOverlay(); AL.shown = rec.id;
    var out = h('p', { class: 'alarm-msg', role: 'status' });
    var kids = [
      h('p', { class: 'alarm-kicker', text: urgent ? (vital ? 'URGENCE VITALE' : 'RENFORT DEMANDÉ') : 'INFORMATION' }),
      h('h2', { text: al.zone_label || 'Lieu à préciser' }),
      h('p', { class: 'alarm-text', text: al.message || '' }),
      h('p', { class: 'alarm-time', text: al.created_at ? 'Alerte du ' + fmt(al.created_at) : '' }), out
    ];
    function done(label) { closeOverlay(); AL.dismissed[rec.id] = 1; lsSet('sauvia.sst.dismissed', AL.dismissed); }
    function reply(r, label) {
      return function (ev) {
        ev.target.disabled = true;
        respond(rec, r).then(function () { done(); toast(label); }).catch(function () { ev.target.disabled = false; out.textContent = 'Réponse non envoyée : réessayez.'; });
      };
    }
    if (urgent) {
      kids.push(h('button', { type: 'button', class: 'alarm-go', text: "J'arrive", onclick: reply('en_route', 'Réponse envoyée : vous êtes en route.') }));
      kids.push(h('button', { type: 'button', class: 'alarm-no', text: 'Indisponible', onclick: reply('indisponible', 'Réponse envoyée : indisponible.') }));
      kids.push(h('a', { class: 'alarm-call', href: 'tel:112', text: "Appeler les secours : 15 · 18 · 112" }));
    } else {
      kids.push(h('button', { type: 'button', class: 'alarm-go', text: 'Vu', onclick: function () { done(); } }));
    }
    var o = h('div', { id: 'alarm', class: 'alarm' + (urgent ? ' alarm-red' : ' alarm-blue'), role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Alerte' }, h.apply(null, ['div', { class: 'alarm-box' }].concat(kids)));
    document.body.appendChild(o);
    startAlarm(urgent);
    var b = o.querySelector('button'); if (b) b.focus();
  }
  function toast(t) { var el = h('div', { class: 'toast', role: 'status', text: t }); document.body.appendChild(el); setTimeout(function () { el.remove(); }, 3500); }
  function pollAlerts() {
    if (!S.session || !S.profile || !navigator.onLine) return Promise.resolve();
    var since = new Date(Date.now() - 30 * 60000).toISOString();
    return api('/rest/v1/alert_recipients?user_id=eq.' + S.session.user_id + '&response=is.null&select=id,kind,alerts!inner(id,level,zone_label,message,created_at,resolved_at)&alerts.resolved_at=is.null&alerts.created_at=gte.' + since + '&limit=5', {})
      .then(function (rows) {
        var list = (rows || []).filter(function (r) { return !AL.dismissed[r.id]; });
        list.sort(function (a, b) { return (a.kind === 'urgence' ? 0 : 1) - (b.kind === 'urgence' ? 0 : 1); });
        if (list.length) showAlarm(list[0]);
        else if (AL.shown) closeOverlay();
      }).catch(function (e) { if (e && e.auth) logout(); else console.error('pollAlerts', e); });
  }
  var alertTimer = null;
  function startAlertPolling() {
    if (alertTimer) return;
    alertTimer = setInterval(function () { if (!document.hidden) pollAlerts(); }, 5000);
    pollAlerts();
  }
  function enablePush() {
    unlockAudio();
    if (!pushSupported()) { AL.push = 'unsupported'; return Promise.resolve(); }
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { AL.push = perm === 'denied' ? 'denied' : 'off'; return; }
      return fetch(CFG.url + '/functions/v1/push-alert?action=key', { headers: { apikey: CFG.anonKey } }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.key) throw new Error('nokey');
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription().then(function (s) { return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(j.key) }); });
        });
      }).then(function (sub) {
        var js = sub.toJSON();
        return api('/rest/v1/rpc/register_push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { p_endpoint: js.endpoint, p_keys: js.keys } });
      }).then(function () { AL.push = 'on'; });
    });
  }
  function testAlarm() {
    unlockAudio();
    showAlarm({ id: 'test-' + Date.now(), kind: 'urgence', alerts: { level: 'renfort', zone_label: 'TEST – aucun accident', message: "Ceci est un essai de l'alarme.", created_at: new Date().toISOString() } });
  }
  function alertSettings() {
    var st = h('p', { class: 'small', role: 'status' });
    function label() {
      st.textContent = AL.push === 'on' ? 'Alertes activées sur ce téléphone.' : AL.push === 'denied' ? 'Notifications bloquées : autorisez-les dans les réglages du navigateur.' : AL.push === 'unsupported' ? "Ce navigateur ne gère pas les notifications. Sur iPhone, ajoutez d'abord Sauvia à l'écran d'accueil." : 'Alertes non activées sur ce téléphone.';
    }
    label();
    var on = h('button', { type: 'button', class: 'ghost small', text: AL.push === 'on' ? 'Réactiver les alertes' : 'Activer les alertes d\'urgence', onclick: function () { enablePush().then(function () { return pushState(); }).catch(function () { st.textContent = 'Activation impossible pour le moment.'; }).then(function () { label(); }); } });
    var test = h('button', { type: 'button', class: 'ghost small', text: "Tester l'alarme", onclick: testAlarm });
    return h('div', { class: 'sect' }, h('h2', { text: 'Alertes sur ce téléphone' }), st,
      h('div', { class: 'row', style: 'justify-content:flex-start;flex-wrap:wrap' }, on, test),
      h('p', { class: 'small', text: "Un navigateur ne peut pas passer outre le mode silencieux ou « Ne pas déranger ». Autorisez Sauvia dans ces modes, ou prévoyez une consigne d'astreinte." }));
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'alert') pollAlerts(); });

  // ---------- démarrage ----------
  var poll = null;
  function startPolling() {
    startAlertPolling(); pushState();
    if (poll) return;
    poll = setInterval(function () { if (document.hidden || !S.session) return; flush(); if (S.view === 'list') loadList().then(function () { if (S.view === 'list') render(); }).catch(function () {}); }, 20000);
  }
  function setOnline() { document.getElementById('offline').hidden = navigator.onLine; }
  window.addEventListener('online', function () { setOnline(); flush(); });
  window.addEventListener('offline', setOnline);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { flush(); pollAlerts(); } });
  setOnline(); showQueued(); loadSession();
  if (S.session) {
    S.profile = lsGet('sauvia.sst.profile', null); S.guides = lsGet('sauvia.sst.guides', []);
    var c = lsGet('sauvia.sst.list', null); if (c) { S.accidents = c.accidents; S.zones = c.zones; }
    render();
    Promise.all([loadProfile(), loadGuides(), loadList()]).then(function () { if (S.view === 'list') render(); startPolling(); flush(); })
      .catch(function (e) { if (e && (e.auth || e.message === 'auth' || e.message === 'noprofile')) logout(); });
  } else { render(); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
