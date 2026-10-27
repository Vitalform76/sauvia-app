(function () {
  'use strict';
  var CFG = window.SAUVIA_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var QR = (params.get('s') || '').trim();

  var state = { pin: '', site: null, photos: [], busy: false };

  // ---------- Réseau ----------
  function headers(extra) {
    var h = { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey };
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }
  function rpc(name, body) {
    return fetch(CFG.url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) { var e = new Error('http_' + r.status); e.http = r.status; throw e; }
      return r.json();
    });
  }
  function uploadPhoto(path, blob) {
    return fetch(CFG.url + '/storage/v1/object/' + CFG.bucket + '/' + path, {
      method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }), body: blob
    }).then(function (r) {
      // 200 = envoyé ; 400/409 « déjà présent » est traité comme un succès
      if (r.ok || r.status === 409) return true;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (String(j.message || '').toLowerCase().indexOf('already exists') >= 0 || j.statusCode === '409') return true;
        var e = new Error('upload_' + r.status); e.http = r.status; throw e;
      });
    });
  }

  // ---------- File d'attente (IndexedDB) ----------
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open('sauvia', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('queue', { keyPath: 'id' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction('queue', mode), s = t.objectStore('queue'), out = fn(s);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  function qPut(item) { return tx('readwrite', function (s) { return s.put(item); }); }
  function qDel(id) { return tx('readwrite', function (s) { return s.delete(id); }); }
  function qAll() { return tx('readonly', function (s) { return s.getAll(); }); }

  // ---------- Affichage ----------
  var screens = ['s-noqr', 's-pin', 's-form', 's-repin', 's-done'];
  function show(id) {
    screens.forEach(function (s) { $(s).hidden = s !== id; });
    window.scrollTo(0, 0);
  }
  function msg(el, text) { el.textContent = text || ''; el.hidden = !text; }
  function setOnline() { $('offline').hidden = navigator.onLine; }
  function siteKey() { return 'sauvia.site.' + QR; }
  function cacheSite(info) { try { localStorage.setItem(siteKey(), JSON.stringify(info)); } catch (e) {} }
  function cachedSite() { try { return JSON.parse(localStorage.getItem(siteKey()) || 'null'); } catch (e) { return null; } }

  function applySite(info) {
    state.site = info;
    $('siteName').textContent = info.site_name || '';
    var sel = $('zone');
    sel.textContent = '';
    (info.zones || []).forEach(function (z) {
      var o = document.createElement('option'); o.value = z.id; o.textContent = z.name; sel.appendChild(o);
    });
    var other = document.createElement('option'); other.value = ''; other.textContent = 'Autre / ne sait pas'; sel.appendChild(other);
  }

  function nowLocalInput() {
    var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  function resetForm() {
    $('form').reset();
    $('quand').value = nowLocalInput();
    state.photos = []; renderThumbs();
    $('interimNote').hidden = true;
    msg($('formMsg'), '');
  }

  // ---------- PIN ----------
  function pinErrorText(code) {
    if (code === 'invalid_pin') return 'Code PIN incorrect.';
    if (code === 'locked') return 'Trop d\'essais. Réessayez dans 15 minutes ou demandez le code à votre responsable.';
    if (code === 'invalid_site') return 'Ce QR code n\'est plus valable. Demandez-en un nouveau à votre responsable.';
    return 'Vérification impossible pour le moment. Réessayez.';
  }
  $('pinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pin = $('pin').value.trim();
    if (!/^[0-9]{4,8}$/.test(pin)) { msg($('pinMsg'), 'Le code PIN contient 4 à 8 chiffres.'); return; }
    msg($('pinMsg'), '');
    var btn = $('pinBtn'); btn.disabled = true;
    var cached = cachedSite();
    rpc('site_info', { p_qr_token: QR, p_pin: pin }).then(function (r) {
      btn.disabled = false;
      if (r && r.ok) {
        state.pin = pin; cacheSite(r); applySite(r); $('pin').value = '';
        resetForm(); show('s-form');
      } else {
        msg($('pinMsg'), pinErrorText(r && r.error));
      }
    }).catch(function () {
      btn.disabled = false;
      // hors connexion : on accepte si le site est connu, le PIN sera vérifié à l'envoi
      if (cached) {
        state.pin = pin; applySite(cached); $('pin').value = '';
        resetForm(); show('s-form');
      } else {
        msg($('pinMsg'), 'Pas de réseau. Ouvrez une première fois ce formulaire avec du réseau pour l\'utiliser ensuite hors connexion.');
      }
    });
  });

  // ---------- Statut ----------
  document.querySelectorAll('input[name=statut]').forEach(function (r) {
    r.addEventListener('change', function () { $('interimNote').hidden = document.querySelector('input[name=statut]:checked').value !== 'interimaire'; });
  });

  // ---------- Photos ----------
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('compress')); }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }
  function renderThumbs() {
    var box = $('thumbs'); box.textContent = '';
    state.photos.forEach(function (p, i) {
      var d = document.createElement('div'); d.className = 't';
      var im = document.createElement('img'); im.alt = 'Photo ' + (i + 1); im.src = p.url;
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Retirer la photo ' + (i + 1)); b.textContent = '×';
      b.addEventListener('click', function () { URL.revokeObjectURL(p.url); state.photos.splice(i, 1); renderThumbs(); });
      d.appendChild(im); d.appendChild(b); box.appendChild(d);
    });
    $('consentRow').hidden = state.photos.length === 0;
    if (!state.photos.length) $('consent').checked = false;
    $('photoBtn').hidden = state.photos.length >= 3;
  }
  $('photo').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f || state.photos.length >= 3) return;
    if (!/^image\//.test(f.type)) { msg($('formMsg'), 'Ce fichier n\'est pas une image.'); return; }
    compress(f).then(function (b) {
      if (b.size > 4.5 * 1024 * 1024) { msg($('formMsg'), 'Photo trop lourde.'); return; }
      state.photos.push({ blob: b, url: URL.createObjectURL(b) }); renderThumbs(); msg($('formMsg'), '');
    }).catch(function () { msg($('formMsg'), 'Photo illisible, essayez-en une autre.'); });
  });

  // ---------- Envoi ----------
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var nom = $('nom').value.trim(), quoi = $('quoi').value.trim(), quand = $('quand').value;
    if (nom.length < 2) { msg($('formMsg'), 'Indiquez le nom de la personne blessée.'); $('nom').focus(); return; }
    if (quoi.length < 3) { msg($('formMsg'), 'Décrivez en quelques mots ce qui s\'est passé.'); $('quoi').focus(); return; }
    if (!quand) { msg($('formMsg'), 'Indiquez quand c\'est arrivé.'); $('quand').focus(); return; }
    var when = new Date(quand);
    if (isNaN(when) || when.getTime() > Date.now() + 3600e3) { msg($('formMsg'), 'La date ne peut pas être dans le futur.'); $('quand').focus(); return; }
    if (state.photos.length && !$('consent').checked) { msg($('formMsg'), 'Confirmez l\'accord de la personne pour les photos, ou retirez-les.'); return; }
    msg($('formMsg'), '');
    var item = {
      id: uuid(), qr: QR, pin: state.pin, company_id: state.site && state.site.company_id,
      createdAt: new Date().toISOString(), state: 'pending',
      payload: {
        victim_name: nom, worker_status: document.querySelector('input[name=statut]:checked').value,
        occurred_at: when.toISOString(), zone_id: $('zone').value || '', location_detail: $('lieu').value.trim(),
        circumstances: quoi
      },
      photos: state.photos.map(function (p) { return p.blob; }), consent: state.photos.length > 0 && $('consent').checked,
      uploaded: [], token: null
    };
    $('sendBtn').disabled = true;
    qPut(item).then(function () {
      state.photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
      return syncOne(item);
    }).then(function (res) {
      $('sendBtn').disabled = false;
      showResult(res, item);
    }).catch(function () {
      $('sendBtn').disabled = false;
      msg($('formMsg'), 'Impossible d\'enregistrer la fiche sur cet appareil. Prévenez un SST directement.');
    });
  });

  function showResult(res, item) {
    var dt = $('doneTitle'), tx = $('doneText'), tb = $('trackBox');
    tb.hidden = true;
    if (res.done) {
      dt.textContent = 'Signalement envoyé';
      tx.textContent = res.photoFail ? 'La fiche est enregistrée. Une photo n\'a pas pu être jointe.' : 'Un sauveteur secouriste du travail va prendre en charge la personne.';
      $('trackCode').textContent = item.token; tb.hidden = false; $('trackState').textContent = '';
      state.lastToken = item.token;
    } else if (res.reason === 'pin') {
      show('s-repin'); return;
    } else if (res.reason === 'rejected') {
      dt.textContent = 'Fiche refusée';
      tx.textContent = res.text || 'La fiche n\'a pas pu être enregistrée. Prévenez un SST directement.';
    } else {
      dt.textContent = 'Fiche enregistrée sur ce téléphone';
      tx.textContent = 'Elle sera envoyée automatiquement dès que le réseau reviendra. Prévenez un SST directement.';
    }
    show('s-done'); refreshPending();
  }

  var inflight = {};
  // Envoie une fiche. Résultat : {done} | {reason:'network'|'pin'|'rejected', text}
  function syncOne(item) {
    if (inflight[item.id]) return Promise.resolve({ reason: 'network' });
    inflight[item.id] = true;
    var photoFail = false;
    var p = item.token ? Promise.resolve({ ok: true, tracking_token: item.token }) : rpc('report_accident', {
      p_qr_token: item.qr, p_pin: item.pin, p_payload: Object.assign({ client_uuid: item.id, client_created_at: item.createdAt }, item.payload)
    });
    return p.then(function (r) {
      if (!r || !r.ok) {
        var e = r && r.error;
        if (e === 'invalid_pin') { item.state = 'pin'; return qPut(item).then(function () { return { reason: 'pin' }; }); }
        if (e === 'locked' || e === 'rate_limited') { return { reason: 'network' }; }
        var t = e === 'invalid_site' ? 'Ce QR code n\'est plus valable.' : 'La fiche n\'a pas pu être enregistrée (données refusées).';
        return qDel(item.id).then(function () { return { reason: 'rejected', text: t }; });
      }
      item.token = r.tracking_token; item.state = 'sent';
      return qPut(item).then(function () { return sendPhotos(item); }).then(function (pf) {
        photoFail = pf;
        return qDel(item.id).then(function () { return { done: true, photoFail: photoFail }; });
      });
    }).catch(function () { return { reason: 'network' }; })
      .then(function (res) { delete inflight[item.id]; return res; });
  }

  // Envoie les photos restantes. Retourne true si une photo est définitivement perdue.
  function sendPhotos(item) {
    var lost = false, chain = Promise.resolve();
    (item.photos || []).forEach(function (blob, i) {
      if (item.uploaded.indexOf(i) >= 0) return;
      chain = chain.then(function () {
        var path = item.company_id + '/' + item.token + '/' + item.id + '-' + i + '.jpg';
        return uploadPhoto(path, blob).then(function () {
          return rpc('report_attach_photo', { p_token: item.token, p_path: path, p_consent: !!item.consent });
        }).then(function (r) {
          if (!r || !r.ok) { lost = true; return; }
          item.uploaded.push(i); return qPut(item);
        }).catch(function (e) {
          if (e && e.http && e.http >= 400 && e.http < 500) { lost = true; return; }
          throw e; // réseau : on reprendra plus tard
        });
      });
    });
    return chain.then(function () { return lost; });
  }

  // ---------- Reprise automatique ----------
  var syncing = false;
  function syncAll() {
    if (syncing || !navigator.onLine) return Promise.resolve();
    syncing = true;
    return qAll().then(function (items) {
      var chain = Promise.resolve();
      items.filter(function (i) { return i.state !== 'pin'; }).forEach(function (it) {
        chain = chain.then(function () { return syncOne(it); });
      });
      return chain;
    }).catch(function () {}).then(function () { syncing = false; return refreshPending(); });
  }
  function refreshPending() {
    return qAll().then(function (items) {
      var el = $('pending'), n = items.length;
      el.hidden = n === 0;
      if (n) el.textContent = n + (n > 1 ? ' fiches en attente d\'envoi sur ce téléphone.' : ' fiche en attente d\'envoi sur ce téléphone.');
      var needPin = items.filter(function (i) { return i.state === 'pin'; });
      if (needPin.length && $('s-done').hidden === true && $('s-form').hidden === true && $('s-pin').hidden === true) show('s-repin');
      return items;
    }).catch(function () {});
  }
  $('repinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pin = $('repin').value.trim();
    if (!/^[0-9]{4,8}$/.test(pin)) { msg($('repinMsg'), 'Le code PIN contient 4 à 8 chiffres.'); return; }
    qAll().then(function (items) {
      var chain = Promise.resolve(), last = null;
      items.filter(function (i) { return i.state === 'pin'; }).forEach(function (it) {
        chain = chain.then(function () { it.pin = pin; it.state = 'pending'; return qPut(it); }).then(function () { return syncOne(it); }).then(function (r) { last = { r: r, it: it }; });
      });
      return chain.then(function () { return last; });
    }).then(function (last) {
      $('repin').value = '';
      if (!last) { show(QR ? 's-pin' : 's-noqr'); return; }
      if (last.r.reason === 'pin') { msg($('repinMsg'), 'Code PIN toujours refusé.'); return; }
      msg($('repinMsg'), '');
      showResult(last.r, last.it);
    });
  });

  // ---------- Suivi ----------
  var STATUS = {
    a_prendre_en_charge: 'En attente de prise en charge', en_attente_visa: 'Pris en charge par un SST',
    a_qualifier: 'Pris en charge', inscrit_registre: 'Pris en charge', dat_a_envoyer: 'Pris en charge', clos: 'Dossier clos'
  };
  $('trackBtn').addEventListener('click', function () {
    if (!state.lastToken) return;
    $('trackState').textContent = '…';
    rpc('report_status', { p_token: state.lastToken }).then(function (r) {
      $('trackState').textContent = r && r.ok ? (STATUS[r.status] || 'Fiche reçue') : 'Fiche introuvable.';
    }).catch(function () { $('trackState').textContent = 'Pas de réseau.'; });
  });
  $('againBtn').addEventListener('click', function () { resetForm(); show(state.site ? 's-form' : (QR ? 's-pin' : 's-noqr')); });

  // ---------- Démarrage ----------
  window.addEventListener('online', function () { setOnline(); syncAll(); });
  window.addEventListener('offline', setOnline);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncAll(); });
  setInterval(syncAll, 30000);
  setOnline();
  $('quand').value = nowLocalInput();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
  var cs = QR && cachedSite();
  if (cs) $('siteName').textContent = cs.site_name || '';
  show(QR ? 's-pin' : 's-noqr');
  syncAll();
})();
