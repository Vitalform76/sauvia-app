(function () {
  'use strict';
  var C = window.SauviaCore; if (!C) return;
  var h = C.h, api = C.api, S = C.S, fmt = C.fmt;
  var R = { tab: 'qualifier', list: [], register: [], names: {}, loaded: false, openId: null, detail: null, msg: '', busy: false, timer: null };
  var TABS = [['qualifier', 'À qualifier'], ['dat', 'DAT à envoyer'], ['encours', 'En cours'], ['registre', 'Registre']];
  var COLS = 'id,site_id,zone_id,victim_name,worker_status,occurred_at,created_at,status,severity,location_detail,circumstances,register_number,sst_visa_at,dat_sent_at';

  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
  function fdate(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : ''; }
  function zone(a) { return (S.zones[a.zone_id] || 'Zone non précisée') + (a.location_detail ? ' – ' + a.location_detail : ''); }
  function who(id) { return (id && R.names[id]) || ''; }

  // ---------- chargement ----------
  function load() {
    return Promise.all([
      api('/rest/v1/accidents?select=' + COLS + '&order=created_at.desc&limit=300'),
      api('/rest/v1/zones?select=id,name'),
      api('/rest/v1/profiles?select=user_id,full_name')
    ]).then(function (r) {
      R.list = r[0] || [];
      S.zones = {}; (r[1] || []).forEach(function (z) { S.zones[z.id] = z.name; });
      R.names = {}; (r[2] || []).forEach(function (p) { R.names[p.user_id] = p.full_name; });
      R.loaded = true;
    }).catch(function (e) { if (e && (e.auth || e.message === 'auth')) C.logout(); });
  }
  function loadRegister() {
    return api('/rest/v1/accidents?register_number=not.is.null&select=id,register_number,occurred_at,victim_name,zone_id,location_detail,circumstances,injury_nature,injury_site,care_situation,care_notes,witnesses,sst_user_id,register_locked_at&order=register_number.asc&limit=2000')
      .then(function (rows) { R.register = rows || []; });
  }
  function openAccident(id) {
    R.openId = id; R.detail = null; R.msg = ''; C.render();
    api('/rest/v1/accidents?id=eq.' + id + '&select=*').then(function (rows) { R.detail = rows && rows[0]; C.render(); })
      .catch(function (e) { if (e.auth) return C.logout(); R.msg = 'Fiche indisponible.'; C.render(); });
  }
  function back() { R.openId = null; R.detail = null; R.msg = ''; R.busy = false; load().then(function () { return R.tab === 'registre' ? loadRegister() : null; }).then(C.render); C.render(); }
  function counts() {
    var n = { qualifier: 0, dat: 0, encours: 0 };
    R.list.forEach(function (a) { if (a.status === 'a_qualifier') n.qualifier++; else if (a.status === 'dat_a_envoyer') n.dat++; else if (a.status === 'a_prendre_en_charge' || a.status === 'en_attente_visa') n.encours++; });
    return n;
  }

  // ---------- vue liste ----------
  function viewList() {
    var n = counts();
    var tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filtre' });
    TABS.forEach(function (t) {
      var c = n[t[0]]; var lbl = t[1] + (c ? ' (' + c + ')' : '');
      tabs.appendChild(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(R.tab === t[0]), text: lbl, onclick: function () {
        R.tab = t[0]; R.msg = '';
        if (t[0] === 'registre') loadRegister().then(C.render).catch(function () { R.msg = 'Registre indisponible hors connexion.'; C.render(); });
        C.render();
      } }));
    });
    var sec = h('section', null, h('div', { class: 'row' }, h('h1', { text: 'Espace responsable' }), h('button', { type: 'button', class: 'ghost small', text: 'Déconnexion', onclick: C.logout })), tabs,
      R.msg ? h('p', { class: 'error', role: 'alert', text: R.msg }) : null);
    if (R.tab === 'registre') { sec.appendChild(viewRegister()); sec.appendChild(C.alertSettings()); return sec; }
    var rows = R.list.filter(function (a) {
      if (R.tab === 'qualifier') return a.status === 'a_qualifier';
      if (R.tab === 'dat') return a.status === 'dat_a_envoyer';
      return a.status === 'a_prendre_en_charge' || a.status === 'en_attente_visa';
    });
    if (!rows.length) sec.appendChild(h('p', { class: 'lead', text: R.tab === 'qualifier' ? 'Aucune fiche à qualifier.' : R.tab === 'dat' ? 'Aucune DAT à envoyer.' : 'Aucune fiche en cours.' }));
    rows.forEach(function (a) {
      var st = C.STATUS[a.status] || [a.status, 'b-clos'];
      sec.appendChild(h('button', { type: 'button', class: 'card', onclick: function () { openAccident(a.id); } },
        h('div', { class: 'row' }, h('h3', { text: a.victim_name }), h('span', { class: 'badge ' + st[1], text: st[0] })),
        h('p', { text: fmt(a.occurred_at) + ' · ' + zone(a) }),
        h('p', { text: (a.worker_status === 'interimaire' ? 'Intérimaire · ' : '') + (C.SEV[a.severity] || 'Gravité non précisée') })));
    });
    sec.appendChild(C.alertSettings());
    return sec;
  }

  // ---------- registre ----------
  function witnessText(w) {
    if (!w) return '';
    if (typeof w === 'string') return w;
    if (Array.isArray(w)) return w.map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.nom)) || ''; }).filter(Boolean).join(', ');
    return '';
  }
  function regRow(a) {
    return [a.register_number, fmt(a.occurred_at), a.victim_name, zone(a), a.circumstances || '', [a.injury_nature, a.injury_site].filter(Boolean).join(' – '),
      [a.care_situation, a.care_notes].filter(Boolean).join(' – '), who(a.sst_user_id), witnessText(a.witnesses)];
  }
  var HEAD = ['N°', 'Date et heure', 'Victime', 'Lieu', 'Circonstances', 'Lésions (nature – siège)', 'Soins donnés', 'Secouriste (SST)', 'Témoin(s)'];
  function exportCsv() {
    function q(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"'; }
    var lines = [HEAD.map(q).join(';')].concat(R.register.map(function (a) { return regRow(a).map(q).join(';'); }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'registre-accidents-benins-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function viewRegister() {
    var box = h('div');
    box.appendChild(h('div', { class: 'row', style: 'justify-content:flex-start;flex-wrap:wrap;margin:0 0 12px' },
      h('button', { type: 'button', class: 'ghost small', text: 'Exporter pour Excel (.csv)', disabled: !R.register.length, onclick: exportCsv }),
      h('button', { type: 'button', class: 'ghost small', text: 'Imprimer / PDF', disabled: !R.register.length, onclick: function () { window.print(); } })));
    if (!R.register.length) { box.appendChild(h('p', { class: 'lead', text: 'Aucun accident inscrit au registre.' })); }
    else {
      var t = h('table', { class: 'regtable' });
      t.appendChild(h('thead', null, h.apply(null, ['tr', null].concat(HEAD.map(function (x) { return h('th', { text: x }); })))));
      var tb = h('tbody');
      R.register.forEach(function (a) { tb.appendChild(h.apply(null, ['tr', null].concat(regRow(a).map(function (x) { return h('td', { text: String(x) }); })))); });
      t.appendChild(tb);
      box.appendChild(h('div', { id: 'regprint' }, h('h2', { text: 'Registre des accidents du travail bénins' }), h('p', { class: 'small', text: 'Édité le ' + fmt(new Date().toISOString()) + ' · inscriptions numérotées et verrouillées' }), h('div', { class: 'regscroll' }, t)));
    }
    box.appendChild(h('p', { class: 'small', text: 'Les rubriques du registre sont à confirmer sur Légifrance (articles D.441-1 et suivants du Code de la sécurité sociale) avant usage réel.' }));
    return box;
  }

  // ---------- DAT ----------
  function deadline(d) {
    var dt = new Date(d), n = 2;
    while (n > 0) { dt.setDate(dt.getDate() + 1); if (dt.getDay() !== 0) n--; }
    return dt;
  }
  function copyBtn(text) {
    var b = h('button', { type: 'button', class: 'ghost small', text: 'Copier', 'aria-label': 'Copier la valeur', onclick: function () {
      var done = function () { b.textContent = 'Copié'; setTimeout(function () { b.textContent = 'Copier'; }, 1500); };
      try { navigator.clipboard.writeText(text).then(done, function () {}); } catch (e) {}
    } });
    return b;
  }
  function datBlock(a) {
    var fields = [
      ['Nom et prénom de la victime', a.victim_name],
      ['Statut', a.worker_status === 'interimaire' ? 'Intérimaire (déclaration par l\'entreprise utilisatrice et l\'agence)' : 'Salarié'],
      ['Date et heure de l\'accident', fmt(a.occurred_at)],
      ['Lieu', zone(a)],
      ['Circonstances', a.circumstances],
      ['Nature de la lésion', a.injury_nature || ''],
      ['Siège de la lésion', a.injury_site || ''],
      ['Témoin(s)', witnessText(a.witnesses)],
      ['Secours appelés', a.rescue_called ? 'Oui' + (a.rescue_service ? ' – ' + a.rescue_service : '') : 'Non'],
      ['Soins par le SST', [a.care_situation, a.care_notes].filter(Boolean).join(' – ')],
      ['Secouriste', who(a.sst_user_id)],
      ['Soins médicaux / arrêt', (a.medical_care ? 'Soins médicaux' : '') + (a.medical_care && a.work_stoppage ? ' ; ' : '') + (a.work_stoppage ? 'Arrêt de travail' : '') || 'Non précisé']
    ];
    var box = h('div', { class: 'sect' }, h('h2', { text: 'Déclaration d\'accident du travail (DAT)' }),
      h('p', { class: 'small', text: 'Recopiez ces informations dans le téléservice net-entreprises. Obligation indicative : déclarer sous 48 h (dimanches exclus), soit avant le ' + deadline(a.created_at).toLocaleDateString('fr-FR') + '. À confirmer (jours fériés non pris en compte).' }));
    fields.forEach(function (f) {
      box.appendChild(h('div', { class: 'datrow' }, h('div', null, h('span', { class: 'datlbl', text: f[0] }), h('span', { class: 'datval', text: f[1] || '—' })), f[1] ? copyBtn(f[1]) : null));
    });
    if (a.status === 'dat_a_envoyer') {
      var ref = h('input', { type: 'text', class: 'sm', maxlength: 100, placeholder: 'Référence ou numéro de récépissé (facultatif)', 'aria-label': 'Référence de la DAT' });
      var out = h('p', { class: 'error', role: 'alert', hidden: true });
      var btn = h('button', { type: 'button', class: 'primary', text: 'J\'ai envoyé la DAT', onclick: function () {
        btn.disabled = true; out.hidden = true;
        api('/rest/v1/rpc/mark_dat_sent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { p_accident_id: a.id, p_reference: ref.value.trim() } })
          .then(function () { back(); }).catch(function (e) { btn.disabled = false; out.textContent = 'Enregistrement impossible : ' + e.message; out.hidden = false; });
      } });
      box.appendChild(h('div', { class: 'field' }, ref)); box.appendChild(out); box.appendChild(btn);
    } else if (a.dat_sent_at) {
      box.appendChild(h('p', { class: 'locked', text: 'DAT envoyée le ' + fmt(a.dat_sent_at) + (a.dat_reference ? ' · réf. ' + a.dat_reference : '') }));
    }
    return box;
  }


  // ---------- compléments (poste, cause, témoins) ----------
  function witnessLines(w) {
    if (!w) return '';
    if (typeof w === 'string') return w;
    if (Array.isArray(w)) return w.map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.nom)) || ''; }).filter(Boolean).join('\n');
    return '';
  }
  function completeBlock(a) {
    var job = h('input', { id: 'cjob', type: 'text', class: 'sm', maxlength: 150, placeholder: 'Ex. opérateur de production', value: a.victim_job || '' });
    var cause = h('input', { id: 'ccause', type: 'text', class: 'sm', maxlength: 300, placeholder: 'Ex. cutter, sol glissant, chute de hauteur', value: a.agent_cause || '' });
    var wit = h('textarea', { id: 'cwit', rows: 3, maxlength: 600, placeholder: 'Un témoin par ligne (nom, prénom)' });
    wit.value = witnessLines(a.witnesses);
    var out = h('p', { class: 'small', role: 'status' });
    var btn = h('button', { type: 'button', class: 'ghost', text: 'Enregistrer les compléments', onclick: function () {
      btn.disabled = true; out.textContent = '';
      var lines = wit.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10);
      api('/rest/v1/accidents?id=eq.' + a.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: { victim_job: job.value.trim() || null, agent_cause: cause.value.trim() || null, witnesses: lines } })
        .then(function (rows) {
          btn.disabled = false;
          if (!rows || !rows.length) { out.textContent = 'Enregistrement refusé.'; return; }
          R.detail = Object.assign(R.detail, rows[0]); out.textContent = 'Compléments enregistrés (modification tracée).';
        }).catch(function (e) { btn.disabled = false; out.textContent = 'Enregistrement impossible : ' + e.message; });
    } });
    return h('div', { class: 'sect' }, h('h2', { text: 'Compléter la fiche' }),
      h('p', { class: 'small', text: 'Informations propres au registre. La fiche de soins du SST n\'est pas modifiée ; chaque modification est tracée.' }),
      h('div', { class: 'field' }, h('label', { for: 'cjob', text: 'Poste ou fonction de la victime' }), job),
      h('div', { class: 'field' }, h('label', { for: 'ccause', text: 'Cause ou élément matériel en cause' }), cause),
      h('div', { class: 'field' }, h('label', { for: 'cwit', text: 'Témoin(s)' }), wit), btn, out);
  }

  // ---------- qualification ----------
  function qualifyBlock(a) {
    var interim = a.worker_status === 'interimaire';
    var med = h('input', { type: 'checkbox', id: 'qmed', checked: !!a.medical_care });
    var stop = h('input', { type: 'checkbox', id: 'qstop', checked: !!a.work_stoppage });
    var reason = h('textarea', { id: 'qreason', rows: 3, maxlength: 500, 'aria-label': 'Motif', placeholder: 'Motif (obligatoire pour une DAT ou une clôture)' });
    var out = h('p', { class: 'error', role: 'alert', hidden: true });
    var choice = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Issue' });
    var opts = [['registre', 'Inscrire au registre des accidents bénins', 'Accident bénin d\'un salarié, sans soins médicaux ni arrêt.'], ['dat', 'Accident du travail à déclarer (DAT)', 'Soins médicaux, arrêt de travail, intérimaire ou gravité.'], ['clos', 'Clore sans suite', 'Sans lien avec le travail ou sans conséquence. Motif obligatoire.']];
    var sel = (interim || a.severity !== 'benin') ? 'dat' : 'registre';
    var radios = {};
    opts.forEach(function (o) {
      var r = h('input', { type: 'radio', name: 'issue', id: 'iss-' + o[0], value: o[0], checked: o[0] === sel, disabled: o[0] === 'registre' && interim });
      radios[o[0]] = r;
      choice.appendChild(h('label', { class: 'choice', for: 'iss-' + o[0] }, r, h('span', null, h('strong', { text: o[1] }), h('small', { text: o[2] }))));
    });
    var btn = h('button', { type: 'button', class: 'primary', text: 'Valider la qualification', onclick: function () {
      var v = Object.keys(radios).filter(function (k) { return radios[k].checked; })[0];
      out.hidden = true;
      if (!v) { out.textContent = 'Choisissez une issue.'; out.hidden = false; return; }
      if (v !== 'registre' && !reason.value.trim()) { out.textContent = 'Le motif est obligatoire.'; out.hidden = false; return; }
      if (v === 'registre' && (med.checked || stop.checked)) { out.textContent = 'Soins médicaux ou arrêt : une DAT est requise, pas une inscription au registre.'; out.hidden = false; return; }
      if (v === 'registre' && !confirm('L\'inscription au registre est définitive : la ligne sera numérotée et verrouillée. Confirmer ?')) return;
      btn.disabled = true;
      api('/rest/v1/rpc/qualify_accident', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { p_accident_id: a.id, p_outcome: v, p_reason: reason.value.trim() || null, p_medical_care: med.checked, p_work_stoppage: stop.checked } })
        .then(function () { back(); }).catch(function (e) { btn.disabled = false; out.textContent = 'Qualification refusée : ' + e.message; out.hidden = false; });
    } });
    return h('div', { class: 'sect' }, h('h2', { text: 'Qualification' }),
      interim ? h('p', { class: 'small', text: 'Intérimaire : pas d\'inscription au registre, déclaration d\'accident du travail requise.' }) : null,
      (!interim && a.severity && a.severity !== 'benin') ? h('p', { class: 'alertline', text: 'Le SST a indiqué une gravité « ' + (C.SEV[a.severity] || a.severity) + ' » : une déclaration d\'accident du travail (DAT) est recommandée.' }) : null,
      h('label', { class: 'check', for: 'qmed' }, med, h('span', { text: 'Soins médicaux nécessaires (médecin, hôpital)' })),
      h('label', { class: 'check', for: 'qstop' }, stop, h('span', { text: 'Arrêt de travail' })),
      choice, h('div', { class: 'field' }, reason), out, btn);
  }

  // ---------- détail ----------
  function viewDetail() {
    var a = R.detail;
    var bk = h('button', { type: 'button', class: 'back', text: '← Retour à la liste', onclick: back });
    if (!a) return h('section', null, bk, R.msg ? h('p', { class: 'error', role: 'alert', text: R.msg }) : h('p', { class: 'lead', text: 'Chargement…' }));
    var st = C.STATUS[a.status] || [a.status, 'b-clos'];
    var sec = h('section', null, bk, h('div', { class: 'row' }, h('h1', { text: a.victim_name }), h('span', { class: 'badge ' + st[1], text: st[0] })));
    sec.appendChild(h('div', { class: 'sect' }, h('h2', { text: 'Accident' }), h('dl', { class: 'kv' },
      h('dt', { text: 'Quand' }), h('dd', { text: fmt(a.occurred_at) }),
      h('dt', { text: 'Où' }), h('dd', { text: zone(a) }),
      h('dt', { text: 'Statut' }), h('dd', { text: a.worker_status === 'interimaire' ? 'Intérimaire' : 'Salarié' }),
      h('dt', { text: 'Récit' }), h('dd', { text: a.circumstances }),
      h('dt', { text: 'Lésion' }), h('dd', { text: [a.injury_nature, a.injury_site].filter(Boolean).join(' – ') || 'Non précisée' }),
      h('dt', { text: 'Gravité' }), h('dd', { text: C.SEV[a.severity] || 'Non précisée' }),
      h('dt', { text: 'Secours' }), h('dd', { text: a.rescue_called ? 'Appelés' + (a.rescue_service ? ' – ' + a.rescue_service : '') : 'Non appelés' }),
      h('dt', { text: 'Soins SST' }), h('dd', { text: [a.care_situation, a.care_notes].filter(Boolean).join(' – ') || 'Non renseignés' }),
      h('dt', { text: 'SST' }), h('dd', { text: who(a.sst_user_id) || '—' }),
      h('dt', { text: 'Visa' }), h('dd', { text: a.sst_visa_at ? fmt(a.sst_visa_at) : 'Non visé' }))));
    if (a.sst_signature || a.victim_signature) {
      var sg = h('div', { class: 'sects' });
      if (a.sst_signature) sg.appendChild(h('figure', null, h('img', { src: a.sst_signature, alt: 'Signature du SST' }), h('figcaption', { text: 'SST' })));
      if (a.victim_signature) sg.appendChild(h('figure', null, h('img', { src: a.victim_signature, alt: 'Signature de la victime' }), h('figcaption', { text: 'Victime' })));
      sec.appendChild(h('div', { class: 'sect' }, h('h2', { text: 'Signatures' }), sg, a.victim_signature_absent_reason ? h('p', { class: 'small', text: 'Victime non signataire : ' + a.victim_signature_absent_reason }) : null));
    }
    if (a.register_number) sec.appendChild(h('p', { class: 'locked', text: 'Inscrit au registre sous le n° ' + a.register_number + '. Ligne verrouillée.' }));
    if (a.status === 'a_qualifier') { sec.appendChild(completeBlock(a)); sec.appendChild(qualifyBlock(a)); }
    if (a.status === 'dat_a_envoyer' || a.dat_sent_at) sec.appendChild(datBlock(a));
    if (a.status === 'clos' && !a.dat_sent_at && a.qualification_reason) sec.appendChild(h('p', { class: 'locked', text: 'Clos. Motif : ' + a.qualification_reason }));
    if (a.status === 'a_prendre_en_charge' || a.status === 'en_attente_visa') sec.appendChild(h('p', { class: 'small', text: 'Cette fiche est encore en cours de prise en charge par un SST. Vous pourrez la qualifier après son visa.' }));
    return sec;
  }

  function view() {
    if (!R.loaded) { load().then(function () { C.render(); startTimer(); }); return h('section', null, h('h1', { text: 'Espace responsable' }), h('p', { class: 'lead', text: 'Chargement…' })); }
    startTimer();
    return R.openId ? viewDetail() : viewList();
  }
  function startTimer() {
    if (R.timer) return;
    R.timer = setInterval(function () {
      if (document.hidden || !S.session || R.openId || !navigator.onLine) return;
      load().then(function () { if (!R.openId && S.profile && S.profile.role === 'responsable') C.render(); });
    }, 20000);
  }
  window.SauviaResp = { view: view };
  if (S.session && S.profile && S.profile.role === 'responsable') C.render();
})();
