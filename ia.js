/* ============================================================
   MODULE ÉQUIPE + IA (Groq)  —  v3.3
   Chargé dynamiquement par app.js : s'il plante, la pointeuse
   continue de fonctionner normalement (sans l'onglet Équipe).
   ============================================================ */
let C = null; // contexte fourni par app.js

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DAYS_FULL = { mon:'Lundi', tue:'Mardi', wed:'Mercredi', thu:'Jeudi', fri:'Vendredi', sat:'Samedi', sun:'Dimanche' };
const DAY_ALIASES = { lundi:'mon', lun:'mon', mardi:'tue', mar:'tue', mercredi:'wed', mer:'wed', jeudi:'thu', jeu:'thu', vendredi:'fri', ven:'fri', samedi:'sat', sam:'sat', dimanche:'sun', dim:'sun' };
const TYPES = ['conge','absent','fixe','travaille','non_travaille','pref'];
const TYPE_LABEL_ADMIN = {
  conge:'Congé', absent:'Absence (jours absent)', fixe:'Horaire fixe (jours + heures)',
  travaille:'Doit travailler (jour ou créneau)', non_travaille:'Ne doit pas travailler (jour ou créneau)',
  pref:'Préférence libre (texte)'
};
const TYPE_LABEL_EMP = {
  conge:'Congé', absent:'Je suis absent(e)', travaille:'Je souhaite travailler',
  non_travaille:'Je préfère ne pas travailler', pref:'Autre remarque / préférence'
};

const S = {
  keys: [], model: DEFAULT_MODEL,
  settings: { maxDayHours: 10, maxGapHours: 4, minDayHours: 3, needTol: 1 },
  needs: {}, rules: {},
  sub: 'needs', ruleEmp: '', week: null,
  self: { empId: null, buf: '', err: '' },
  plan: null, status: '', busy: false,
  chat: [], pending: null,
  cooldown: {}, keyIdx: 0, keyTest: {}, adminMsg: ''
};

/* ---------- petits utilitaires ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fr = iso => iso ? iso.split('-').reverse().join('/') : '';
const slots = () => [...C.state.timeSlots].sort((a, b) => a.start.localeCompare(b.start));
const emps = () => C.state.employees;
const slotById = id => slots().find(s => s.id === id);
const slotName = id => (slotById(id) || {}).name || id;
const rulesOf = id => S.rules[id] || (S.rules[id] = []);
const saveRules = id => C.saveJSON('ia_rules_' + id, rulesOf(id));
const slotLen = s => toMin(s.end) - toMin(s.start);
/* bloc entier = créneau assez long (matin, après-midi…) : un employé qui travaille doit en faire au moins un */
/* tolérance sur le nombre de personnes par créneau : besoin ± needTol (un créneau à 1 personne n'est jamais laissé vide) */
const tol = () => Math.max(0, parseInt(S.settings.needTol, 10) || 0);
const minNeed = need => need <= 1 ? need : Math.max(1, need - tol());
const isMain = s => !!s && slotLen(s) >= S.settings.minDayHours * 60;
const minSlotMin = () => { const l = slots().map(slotLen).filter(x => x > 0); return l.length ? Math.min(...l) : 60; };
function weekDates(weekKey) {
  const m = new Date(weekKey + 'T00:00:00');
  return C.DAYS.map((d, i) => { const x = new Date(m); x.setDate(m.getDate() + i); return C.isoDate(x); });
}
function dayKeyOf(x) { const s = norm(x); if (DAYS_FULL[s]) return s; return DAY_ALIASES[s] || null; }
function slotIdOf(x) {
  const s = norm(x);
  const f = slots().find(sl => sl.id === x || norm(sl.name) === s);
  return f ? f.id : null;
}
function findEmp(x) {
  const s = norm(x);
  return emps().find(e => e.id === x) || emps().find(e => norm(e.name) === s) || emps().find(e => norm(e.name).includes(s) && s.length >= 2);
}

/* ============================================================
   INIT
   ============================================================ */
export async function initIA(ctx) {
  C = ctx;
  S.week = ctx.isoDate(ctx.mondayOf(new Date()));
  S.keys = await ctx.loadJSON('ia_keys', []);
  S.model = await ctx.loadJSON('ia_model', DEFAULT_MODEL);
  S.settings = Object.assign({ maxDayHours: 10, maxGapHours: 4, minDayHours: 3, needTol: 1 }, await ctx.loadJSON('ia_settings', {}));
  S.needs = await ctx.loadJSON('ia_needs', {});
  await Promise.all(ctx.state.employees.map(async e => { S.rules[e.id] = await ctx.loadJSON('ia_rules_' + e.id, []); }));
}

/* ============================================================
   RÈGLES (contraintes)
   ============================================================ */
function normalizeRule(raw, by) {
  const type = raw.type;
  if (!TYPES.includes(type)) return 'Type de règle inconnu.';
  if (by === 'employee' && type === 'fixe') return 'Un horaire fixe ne peut être défini que par l\'administration.';
  const iso = /^\d{4}-\d{2}-\d{2}$/, hm = /^\d{2}:\d{2}$/;
  const r = { id: C.uid(), type, level: 'strict', days: [], from: '', to: '', slotIds: [], start: '', end: '', breakStart: '', breakEnd: '', note: String(raw.note || '').slice(0, 300), by };
  r.days = [...new Set((raw.days || []).map(dayKeyOf).filter(Boolean))];
  const slotRaw = [...(raw.slotIds || []), ...(raw.slots || [])];
  r.slotIds = [...new Set(slotRaw.map(slotIdOf).filter(Boolean))];
  r.from = iso.test(raw.from || '') ? raw.from : '';
  r.to = iso.test(raw.to || '') ? raw.to : '';
  if (r.from && r.to && r.to < r.from) return 'La date de fin doit être après la date de début.';
  if (type === 'conge' || type === 'absent') {
    if (!r.from) return 'Indiquez au moins la date de début.';
    if (!r.to) r.to = r.from;
    r.days = []; r.slotIds = [];
  } else if (type === 'fixe') {
    if (!hm.test(raw.start || '') || !hm.test(raw.end || '')) return 'Indiquez l\'heure d\'arrivée et de départ.';
    if (raw.start >= raw.end) return 'Le départ doit être après l\'arrivée.';
    r.start = raw.start; r.end = raw.end;
    if (raw.breakStart || raw.breakEnd) {
      if (!hm.test(raw.breakStart || '') || !hm.test(raw.breakEnd || '') || raw.breakStart >= raw.breakEnd || raw.breakStart < r.start || raw.breakEnd > r.end) return 'Coupure invalide (elle doit être comprise entre l\'arrivée et le départ).';
      r.breakStart = raw.breakStart; r.breakEnd = raw.breakEnd;
    }
    if (!r.days.length) return 'Choisissez au moins un jour.';
    r.slotIds = [];
  } else if (type === 'travaille' || type === 'non_travaille') {
    if (!r.days.length && !r.slotIds.length && !r.from) return 'Choisissez au moins un jour, un créneau ou une période.';
    const lv = norm(raw.level);
    r.level = (by === 'employee' || lv.startsWith('souhait')) ? 'souhait' : 'strict';
  } else if (type === 'pref') {
    if (!r.note) return 'Écrivez votre préférence dans la note.';
    r.level = 'souhait'; r.days = []; r.slotIds = [];
  }
  return r;
}

function describeRule(r) {
  const dn = r.days.map(d => DAYS_FULL[d].slice(0, 3)).join(', ');
  const per = r.from ? (r.to && r.to !== r.from ? `du ${fr(r.from)} au ${fr(r.to)}` : `le ${fr(r.from)}`) : (r.to ? `jusqu'au ${fr(r.to)}` : '');
  const sn = r.slotIds.map(slotName).join(', ');
  const lvl = r.level === 'souhait' ? ' (souhait)' : ' (obligatoire)';
  const note = r.note && r.type !== 'pref' ? ' — ' + r.note : '';
  const join = (...a) => a.filter(Boolean).join(' · ');
  switch (r.type) {
    case 'conge': return `Congé ${per}${note}`;
    case 'absent': return `Absent ${per}${note}`;
    case 'fixe': return `Horaire fixe : ${join(dn, r.start + '–' + r.end + (r.breakStart ? ` (coupure ${r.breakStart}–${r.breakEnd})` : ''), per)}${note}`;
    case 'travaille': return `Travaille : ${join(dn, sn, per)}${lvl}${note}`;
    case 'non_travaille': return `Ne travaille pas : ${join(dn, sn, per)}${lvl}${note}`;
    default: return `Préférence : ${r.note}`;
  }
}

function applies(r, dateStr, dayKey) {
  if (r.from && dateStr < r.from) return false;
  if (r.to && dateStr > r.to) return false;
  if (r.days && r.days.length && !r.days.includes(dayKey)) return false;
  return true;
}

/* contraintes d'un employé pour une date donnée */
function dayInfo(empId, dateStr, dayKey) {
  const info = { off: null, fixed: null, forbidDay: false, forbidSlots: new Set(), mustDay: false, mustSlots: new Set(),
    avoidDay: false, avoidSlots: new Set(), wantDay: false, wantSlots: new Set() };
  rulesOf(empId).forEach(r => {
    if (!applies(r, dateStr, dayKey)) return;
    if (r.type === 'conge' || r.type === 'absent') { info.off = r.type; return; }
    if (r.type === 'fixe') { info.fixed = r; return; }
    const strict = r.level !== 'souhait', sl = r.slotIds || [];
    if (r.type === 'non_travaille') {
      if (strict) { sl.length ? sl.forEach(x => info.forbidSlots.add(x)) : (info.forbidDay = true); }
      else { sl.length ? sl.forEach(x => info.avoidSlots.add(x)) : (info.avoidDay = true); }
    } else if (r.type === 'travaille') {
      if (strict) { sl.length ? sl.forEach(x => info.mustSlots.add(x)) : (info.mustDay = true); }
      else { sl.length ? sl.forEach(x => info.wantSlots.add(x)) : (info.wantDay = true); }
    }
  });
  return info;
}

/* utilisé par app.js pour afficher « Congé » / « Absent » dans le planning existant */
export function absenceFor(empId, dateStr) {
  if (!C) return null;
  for (const r of rulesOf(empId)) {
    if ((r.type === 'conge' || r.type === 'absent') && (!r.from || dateStr >= r.from) && (!r.to || dateStr <= r.to)) return r.type === 'conge' ? 'Congé' : 'Absent';
  }
  return null;
}

/* ============================================================
   MODÈLE DE PLANNING (créneaux entiers)
   ============================================================ */
function segsFromSlotIds(ids) {
  const list = slots().filter(s => ids.includes(s.id));
  const segs = [];
  list.forEach(s => {
    const l = segs[segs.length - 1];
    if (l && toMin(l.end) >= toMin(s.start)) { if (toMin(s.end) > toMin(l.end)) l.end = s.end; }
    else segs.push({ start: s.start, end: s.end });
  });
  return segs;
}
function segsOfFixed(r) {
  if (r.breakStart && r.breakEnd) return [{ start: r.start, end: r.breakStart }, { start: r.breakEnd, end: r.end }];
  return [{ start: r.start, end: r.end }];
}
const segMin = segs => segs.reduce((t, s) => t + toMin(s.end) - toMin(s.start), 0);
function coversSlot(segs, slot) {
  const len = slotLen(slot); let ov = 0;
  segs.forEach(s => { ov += Math.max(0, Math.min(toMin(s.end), toMin(slot.end)) - Math.max(toMin(s.start), toMin(slot.start))); });
  return len > 0 && ov * 2 >= len;
}
function dayObjFromSegs(segs) {
  if (!segs.length) return { repos: true, start: '', end: '', breakStart: '', breakEnd: '' };
  if (segs.length === 1) return { repos: false, start: segs[0].start, end: segs[0].end, breakStart: '', breakEnd: '' };
  return { repos: false, start: segs[0].start, end: segs[segs.length - 1].end, breakStart: segs[0].end, breakEnd: segs[1].start };
}
const newPlan = weekKey => ({ weekKey, assign: {}, fixed: {}, source: '', note: '' });
const minToStr = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function planSegs(plan, empId, dk) {
  const fx = (plan.fixed[empId] || {})[dk];
  if (fx) return segsOfFixed(fx);
  const segs = segsFromSlotIds((plan.assign[empId] || {})[dk] || []);
  const a = plan.adj && plan.adj[empId] && plan.adj[empId][dk];
  if (a && segs.length) {
    if (a.before) segs[0].start = minToStr(toMin(segs[0].start) - a.before);
    if (a.after) segs[segs.length - 1].end = minToStr(toMin(segs[segs.length - 1].end) + a.after);
  }
  return segs;
}
function placeFixed(plan) {
  const dates = weekDates(plan.weekKey);
  emps().forEach(e => {
    plan.assign[e.id] = plan.assign[e.id] || {};
    plan.fixed[e.id] = {};
    C.DAYS.forEach((d, i) => {
      const inf = dayInfo(e.id, dates[i], d.key);
      if (inf.fixed && !inf.off && inf.fixed.start && inf.fixed.end) plan.fixed[e.id][d.key] = inf.fixed;
    });
  });
}
/* objectif de la semaine, réduit au prorata des jours de congé (lun–ven) */
function targetMin(e, dates) {
  if (e.weeklyHours == null || e.weeklyHours === '') return null;
  let leave = 0;
  dates.forEach((d, i) => { if (i < 5 && dayInfo(e.id, d, C.DAYS[i].key).off) leave++; });
  return Math.round(Number(e.weeklyHours) * 60 * Math.max(0, 1 - leave / 5));
}

/* ---------- vérification ---------- */
function validate(plan) {
  const dates = weekDates(plan.weekKey), sl = slots(), errors = [], warnings = [], tolerated = [], total = {}, remaining = {};
  const maxDay = S.settings.maxDayHours * 60, maxGap = S.settings.maxGapHours * 60;
  const cover = {};
  emps().forEach(e => {
    let tot = 0;
    C.DAYS.forEach((d, i) => {
      const inf = dayInfo(e.id, dates[i], d.key);
      const ids = (plan.assign[e.id] || {})[d.key] || [];
      const fx = (plan.fixed[e.id] || {})[d.key];
      const segs = planSegs(plan, e.id, d.key);
      const label = `${e.name} (${DAYS_FULL[d.key]})`;
      const worked = segs.length > 0;
      if (worked && inf.off) errors.push(`${label} : ${inf.off === 'conge' ? 'en congé' : 'absent'}`);
      if (!inf.off && inf.fixed && !fx) errors.push(`${label} : horaire fixe non respecté`);
      if (fx && ids.length) errors.push(`${label} : créneau ajouté sur un jour à horaire fixe`);
      if (inf.forbidDay && worked && !fx) errors.push(`${label} : ne doit pas travailler ce jour`);
      ids.forEach(id => { if (inf.forbidSlots.has(id)) errors.push(`${label} : créneau interdit (${slotName(id)})`); });
      if (!inf.off) {
        if (!worked && inf.mustDay) errors.push(`${label} : doit travailler ce jour`);
        inf.mustSlots.forEach(id => { const s = slotById(id); if (s && !ids.includes(id) && !(fx && coversSlot(segs, s))) errors.push(`${label} : doit travailler ${slotName(id)}`); });
      }
      if (!fx) {
        if (segs.length > 2) errors.push(`${label} : plus d'une coupure`);
        else if (segs.length === 2 && toMin(segs[1].start) - toMin(segs[0].end) > maxGap) errors.push(`${label} : coupure trop longue`);
        const m = segMin(segs);
        if (m > maxDay) errors.push(`${label} : plus de ${S.settings.maxDayHours}h dans la journée`);
        if (worked && !ids.some(id => isMain(slotById(id)))) errors.push(`${label} : il faut au moins un matin ou un après-midi entier`);
      }
      tot += segMin(segs);
      sl.forEach(s => {
        const hit = fx ? coversSlot(segs, s) : ids.includes(s.id);
        if (hit) { const k = d.key + '|' + s.id; (cover[k] = cover[k] || []).push(e.name); }
      });
    });
    total[e.id] = tot;
    const t = targetMin(e, dates);
    remaining[e.id] = t == null ? null : t - tot;
  });
  sl.forEach(s => C.DAYS.forEach(d => {
    const need = (S.needs[s.id] || {})[d.key] || 0;
    const n = (cover[d.key + '|' + s.id] || []).length;
    const lbl = `${DAYS_FULL[d.key].slice(0, 3)} ${s.name} ${n}/${need}`;
    if (n < minNeed(need)) errors.push(`${DAYS_FULL[d.key]} ${s.name} : ${n}/${need} personne(s) (minimum ${minNeed(need)})`);
    else if (n < need) tolerated.push(lbl);
    else if (need > 0 && n > need + tol()) warnings.push(`${DAYS_FULL[d.key]} ${s.name} : ${n} personnes pour ${need} demandée(s)`);
    else if (need > 0 && n > need) tolerated.push(lbl);
  }));
  let over = 0, under = 0;
  emps().forEach(e => {
    const r = remaining[e.id]; if (r == null) return;
    if (r < 0) { over += -r; warnings.push(`${e.name} : dépasse son objectif de ${C.hoursFmt(-r / 60)}`); }
    else if (r >= 15) { under += r; warnings.push(`${e.name} : il manque ${C.hoursFmt(r / 60)} pour atteindre son objectif`); }
  });
  return { errors, warnings, tolerated, total, remaining, over, under };
}
const planScore = v => v.errors.length * 1000 + v.tolerated.length * 3 + (v.over / 60) * 20 + (v.under / 60) * 2;

/* ---------- moteur de répartition (calculateur interne) ---------- */
function engine(plan) {
  const dates = weekDates(plan.weekKey), sl = slots();
  const maxDay = S.settings.maxDayHours * 60, maxGap = S.settings.maxGapHours * 60, minDay = S.settings.minDayHours * 60;
  const info = {}, minutes = {}, target = {}, hard = {}, cover = {};
  const lastId = sl.length ? sl[sl.length - 1].id : null;
  const isHard = (dk, s) => s.id === lastId || dk === 'sat' || dk === 'sun';
  emps().forEach(e => {
    info[e.id] = {}; minutes[e.id] = 0; hard[e.id] = 0; target[e.id] = targetMin(e, dates);
    plan.assign[e.id] = plan.assign[e.id] || {};
    C.DAYS.forEach((d, i) => {
      info[e.id][d.key] = dayInfo(e.id, dates[i], d.key);
      const fx = (plan.fixed[e.id] || {})[d.key];
      minutes[e.id] += segMin(planSegs(plan, e.id, d.key));
      if (fx) {
        const segs = segsOfFixed(fx);
        sl.forEach(s => { if (coversSlot(segs, s)) cover[d.key + '|' + s.id] = (cover[d.key + '|' + s.id] || 0) + 1; });
      }
      (plan.assign[e.id][d.key] || []).forEach(id => {
        const s = slotById(id); if (!s) return;
        cover[d.key + '|' + id] = (cover[d.key + '|' + id] || 0) + 1;
        if (isHard(d.key, s)) hard[e.id]++;
      });
    });
  });
  const need = (dk, s) => (S.needs[s.id] || {})[dk] || 0;
  const cov = (dk, s) => cover[dk + '|' + s.id] || 0;
  function canAdd(e, dk, s, relax) {
    const inf = info[e.id][dk];
    if (inf.off || inf.fixed || inf.forbidDay || inf.forbidSlots.has(s.id)) return false;
    const cur = plan.assign[e.id][dk] || [];
    if (cur.includes(s.id)) return false;
    const segs = segsFromSlotIds([...cur, s.id]);
    if (segs.length > 2) return false;
    if (segs.length === 2 && toMin(segs[1].start) - toMin(segs[0].end) > maxGap) return false;
    if (segMin(segs) > maxDay) return false;
    if (target[e.id] != null && minutes[e.id] + slotLen(s) > target[e.id]) return false;   // jamais plus que l'objectif
    return true;
  }
  function add(e, dk, s) {
    (plan.assign[e.id][dk] = plan.assign[e.id][dk] || []).push(s.id);
    minutes[e.id] += slotLen(s);
    cover[dk + '|' + s.id] = (cover[dk + '|' + s.id] || 0) + 1;
    if (isHard(dk, s)) hard[e.id]++;
  }
  function score(e, dk, s) {
    const inf = info[e.id][dk], cur = plan.assign[e.id][dk] || [];
    const t = target[e.id], remH = t == null ? 0 : (t - minutes[e.id]) / 60;
    let sc = -remH * 0.6;                                   // priorité à ceux qui ont le plus d'heures à faire
    const dayM = segMin(segsFromSlotIds(cur));
    sc += (dayM / 60) * 0.8;                                // éviter d'empiler une seule journée
    if (cur.length) {
      const segs = segsFromSlotIds([...cur, s.id]);
      sc += segs.length === 1 ? -2.5 : 2;                   // créneaux collés = journée logique
      if (!cur.some(id => isMain(slotById(id))) && isMain(s)) sc -= 3;
    } else if (!isMain(s)) sc += 8;                         // ne jamais démarrer une journée par un petit créneau
    if (inf.mustDay && !cur.length) sc -= 50;
    if (inf.wantDay) sc -= 3;
    if (inf.wantSlots.has(s.id)) sc -= 4;
    if (inf.avoidDay) sc += 4;
    if (inf.avoidSlots.has(s.id)) sc += 5;
    if (isHard(dk, s)) sc += hard[e.id] * 1.2;              // équité soirs / week-ends
    return sc + Math.random() * 0.4;
  }
  return { info, minutes, target, need, cov, canAdd, add, score };
}

function solve(weekKey) {
  const plan = newPlan(weekKey); placeFixed(plan);
  const eng = engine(plan), sl = slots();
  // 1. créneaux obligatoires
  emps().forEach(e => C.DAYS.forEach(d => {
    const inf = eng.info[e.id][d.key]; if (inf.off || inf.fixed) return;
    inf.mustSlots.forEach(id => { const s = slotById(id); if (s && eng.canAdd(e, d.key, s, true)) eng.add(e, d.key, s); });
  }));
  // 2. couverture : d'abord le minimum toléré partout, puis on monte jusqu'au besoin exact
  for (const level of ['min', 'full']) {
    const units = [];
    sl.forEach(s => C.DAYS.forEach(d => {
      const nd = eng.need(d.key, s), want = level === 'min' ? minNeed(nd) : nd;
      const miss = want - eng.cov(d.key, s);
      if (miss > 0) units.push({ s, dk: d.key, miss, cands: emps().filter(e => eng.canAdd(e, d.key, s, true)).length });
    }));
    units.sort((a, b) => a.cands - b.cands);
    units.forEach(u => {
      for (let k = 0; k < u.miss; k++) {
        let best = null;
        emps().forEach(e => { if (eng.canAdd(e, u.dk, u.s, true)) { const sc = eng.score(e, u.dk, u.s); if (!best || sc < best.sc) best = { e, sc }; } });
        if (best) eng.add(best.e, u.dk, u.s);
      }
    });
  }
  // 3. chaque journée travaillée doit contenir un matin ou un après-midi entier
  emps().forEach(e => C.DAYS.forEach(d => {
    const ids = plan.assign[e.id][d.key] || [];
    if (!ids.length || ids.some(id => isMain(slotById(id)))) return;
    let best = null;
    sl.forEach(s => { if (isMain(s) && eng.canAdd(e, d.key, s, true)) { const sc = eng.score(e, d.key, s); if (!best || sc < best.sc) best = { s, sc }; } });
    if (best) eng.add(e, d.key, best.s);
    else plan.assign[e.id][d.key] = [];                    // impossible : on retire le petit créneau isolé
  }));
  plan.source = 'auto';
  return plan;
}

/* complète automatiquement les heures restantes (sans dépasser l'objectif, en restant dans besoin + tolérance si possible) */
function fillRemaining(plan) {
  const eng = engine(plan), sl = slots(); let added = 0;
  emps().forEach(e => {
    const t = eng.target[e.id]; if (t == null) return;
    for (let guard = 0; guard < 40; guard++) {
      const room = t - eng.minutes[e.id]; let best = null;
      for (const capped of [true, false]) {
        C.DAYS.forEach(d => sl.forEach(s => {
          if (slotLen(s) > room || !eng.canAdd(e, d.key, s, false)) return;
          const cur = plan.assign[e.id][d.key] || [];
          if (!cur.length && !isMain(s)) return;
          const nd = eng.need(d.key, s);
          if (capped && nd > 0 && eng.cov(d.key, s) >= nd + tol()) return;
          const sc = eng.score(e, d.key, s) - (eng.cov(d.key, s) < nd ? 2 : 0);
          if (!best || sc < best.sc) best = { s, dk: d.key, sc };
        }));
        if (best) break;
      }
      if (!best) break; eng.add(e, best.dk, best.s); added++;
    }
  });
  return added;
}

/* ---------- heures EXACTES : on raccourcit / prolonge un début ou une fin de journée ---------- */
function adjustToTarget(plan) {
  const dates = weekDates(plan.weekKey), sl = slots();
  const minDay = S.settings.minDayHours * 60, maxDay = S.settings.maxDayHours * 60;
  const byStart = (a, b) => a.start.localeCompare(b.start);
  plan.adj = plan.adj || {};
  emps().forEach(e => {
    const t = targetMin(e, dates); if (t == null) return;
    plan.adj[e.id] = plan.adj[e.id] || {};
    const worked = () => C.DAYS.filter(d => !(plan.fixed[e.id] || {})[d.key] && ((plan.assign[e.id] || {})[d.key] || []).length);
    const dayTot = k => segMin(planSegs(plan, e.id, k));
    const total = () => C.DAYS.reduce((acc, d) => acc + dayTot(d.key), 0);
    const adjOf = k => plan.adj[e.id][k] || (plan.adj[e.id][k] = { before: 0, after: 0 });
    const ordered = k => plan.assign[e.id][k].map(slotById).filter(Boolean).sort(byStart);
    const r15 = x => x - (x % 15);

    // retirer (jusqu'à 1/2 créneau par bord) pour redescendre à l'objectif
    const trim = x => {
      const days = worked().sort((a, b) => dayTot(b.key) - dayTot(a.key));
      for (const d of days) {
        if (x <= 0) break;
        const ord = ordered(d.key); if (!ord.length) continue;
        const a = adjOf(d.key);
        let take = r15(Math.min(x, a.after + Math.floor(slotLen(ord[ord.length - 1]) / 2), dayTot(d.key) - minDay));
        if (take > 0) { a.after -= take; x -= take; }
        take = r15(Math.min(x, a.before + Math.floor(slotLen(ord[0]) / 2), dayTot(d.key) - minDay));
        if (take > 0) { a.before -= take; x -= take; }
      }
      return x;
    };
    // ajouter : prolonger vers un créneau voisin libre (arriver plus tôt / partir plus tard)
    const extend = x => {
      const days = worked().sort((a, b) => dayTot(a.key) - dayTot(b.key));
      const idx = k => C.DAYS.findIndex(d => d.key === k);
      for (const d of days) {
        if (x <= 0) break;
        const ids = plan.assign[e.id][d.key], raw = segsFromSlotIds(ids);
        if (!raw.length) continue;
        const inf = dayInfo(e.id, dates[idx(d.key)], d.key), a = adjOf(d.key);
        const nxt = sl.find(s => s.start === raw[raw.length - 1].end && !ids.includes(s.id) && !inf.forbidSlots.has(s.id));
        if (nxt) {
          const take = r15(Math.min(x, slotLen(nxt) - a.after, maxDay - dayTot(d.key)));
          if (take > 0) { a.after += take; x -= take; }
        }
        const prv = sl.find(s => s.end === raw[0].start && !ids.includes(s.id) && !inf.forbidSlots.has(s.id));
        if (prv && x > 0) {
          const take = r15(Math.min(x, slotLen(prv) - a.before, maxDay - dayTot(d.key)));
          if (take > 0) { a.before += take; x -= take; }
        }
      }
      return x;
    };
    // retirer un créneau entier en surplus de couverture (sans créer de trou)
    const removeSurplus = over => {
      const eng = engine(plan); let best = null;
      worked().forEach(d => {
        const inf = eng.info[e.id][d.key], ids = plan.assign[e.id][d.key];
        ids.forEach(id => {
          const s = slotById(id); if (!s || inf.mustSlots.has(id)) return;
          if (over < slotLen(s) * 0.75) return;
          const nd = eng.need(d.key, s), cv = eng.cov(d.key, s);
          if (cv <= (nd > 0 ? minNeed(nd) : 0)) return;
          const surplus = cv - nd;
          const rest = ids.filter(x => x !== id);
          if (rest.length && !rest.some(x => isMain(slotById(x)))) return;
          if (!rest.length && inf.mustDay) return;
          if (!best || surplus > best.surplus) best = { d, id, surplus };
        });
      });
      if (!best) return false;
      plan.assign[e.id][best.d.key] = plan.assign[e.id][best.d.key].filter(x => x !== best.id);
      plan.adj[e.id][best.d.key] = { before: 0, after: 0 };
      return true;
    };
    for (let guard = 0; guard < 14; guard++) {
      const diff = t - total();
      if (diff === 0) break;
      if (diff < 0) {
        if (removeSurplus(-diff)) continue;
        if (trim(-diff) === -diff) break;       // plus rien à retirer
      } else if (extend(diff) === diff) break;  // plus rien à ajouter
    }
  });
}
/* complète les heures manquantes puis ajuste pour tomber pile sur l'objectif */
function completePlan(plan) {
  plan.adj = {};
  const n = fillRemaining(plan);
  adjustToTarget(plan);
  return n;
}

/* ============================================================
   GROQ (plusieurs clés, bascule automatique)
   ============================================================ */
const enabledKeys = () => S.keys.filter(k => k.enabled !== false && k.key);
async function callGroq(messages, opts = {}) {
  const ks = enabledKeys();
  if (!ks.length) throw new Error('Aucune clé API Groq active (Admin → Intelligence artificielle).');
  const n = ks.length; let lastErr = null;
  for (let t = 0; t < n; t++) {
    const k = ks[(S.keyIdx + t) % n];
    if ((S.cooldown[k.id] || 0) > Date.now() && t < n - 1) continue;
    try {
      const body = { model: S.model || DEFAULT_MODEL, messages, temperature: opts.temperature ?? 0.3 };
      if (opts.json) body.response_format = { type: 'json_object' };
      const r = await fetch(GROQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.key }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) {
        S.cooldown[k.id] = Date.now() + (r.status === 429 ? 60000 : 300000);
        lastErr = new Error(`${k.name || 'Clé'} : erreur ${r.status}${r.status === 429 ? ' (limite atteinte)' : ''}`);
        continue;
      }
      if (!r.ok) {
        if (r.status === 400 && opts.json) return callGroq(messages, { ...opts, json: false });
        const tx = await r.text();
        throw new Error('Groq ' + r.status + ' : ' + tx.slice(0, 200));
      }
      const data = await r.json();
      S.keyIdx = (S.keyIdx + t) % n;
      return data.choices[0].message.content;
    } catch (e) {
      if (String(e.message).startsWith('Groq')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Échec de l\'appel IA');
}
function parseJSON(txt) {
  if (!txt) return null;
  let t = String(txt).replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* ignore */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* ignore */ } }
  return null;
}

/* ============================================================
   GÉNÉRATION (IA + vérification + secours)
   ============================================================ */
function planFromAI(weekKey, parsed) {
  const plan = newPlan(weekKey); placeFixed(plan);
  const a = (parsed && parsed.assignments) || {}, ids = new Set(slots().map(s => s.id));
  emps().forEach(e => {
    plan.assign[e.id] = {};
    const ea = a[e.id] || a[e.name] || {};
    C.DAYS.forEach(d => {
      if (plan.fixed[e.id][d.key]) return;
      const arr = Array.isArray(ea[d.key]) ? ea[d.key].filter(x => ids.has(x)) : [];
      if (arr.length) plan.assign[e.id][d.key] = [...new Set(arr)];
    });
  });
  plan.source = 'ia';
  return plan;
}

async function aiGenerate(weekKey, onStatus) {
  const base = solve(weekKey);
  let best = { plan: base, v: validate(base), src: 'auto' };
  if (!enabledKeys().length) {
    const n0 = completePlan(best.plan);
    return { plan: best.plan, src: 'auto', note: 'Aucune clé IA active : génération automatique.' + (n0 ? ` ${n0} créneau(x) ajouté(s) pour atteindre les heures de chacun.` : '') };
  }

  const sl = slots(), fixedPlan = newPlan(weekKey); placeFixed(fixedPlan);
  const eng = engine(fixedPlan);
  const needsLeft = {};
  sl.forEach(s => { needsLeft[s.name + ' (' + s.id + ')'] = {}; C.DAYS.forEach(d => { needsLeft[s.name + ' (' + s.id + ')'][d.key] = Math.max(0, eng.need(d.key, s) - eng.cov(d.key, s)); }); });
  const empCtx = emps().map(e => {
    const jours = {};
    C.DAYS.forEach(d => {
      const inf = eng.info[e.id][d.key];
      if (inf.off || inf.forbidDay) { jours[d.key] = 'indisponible'; return; }
      if (fixedPlan.fixed[e.id][d.key]) { jours[d.key] = 'horaire fixe (déjà placé)'; return; }
      const st = { allowed: sl.filter(s => !inf.forbidSlots.has(s.id)).map(s => s.id) };
      if (inf.mustDay) st.doitTravailler = true;
      if (inf.mustSlots.size) st.doitTravaillerCreneaux = [...inf.mustSlots];
      if (inf.wantDay || inf.wantSlots.size) st.prefere = inf.wantDay ? 'ce jour' : [...inf.wantSlots];
      if (inf.avoidDay || inf.avoidSlots.size) st.evite = inf.avoidDay ? 'ce jour' : [...inf.avoidSlots];
      jours[d.key] = st;
    });
    return { id: e.id, nom: e.name, objectifMinutes: eng.target[e.id], dejaPlaceMinutes: eng.minutes[e.id], jours, notes: rulesOf(e.id).filter(r => r.type === 'pref' || (r.note && r.level === 'souhait')).map(r => r.note) };
  });
  const data = {
    semaineDuLundi: weekKey,
    creneaux: sl.map(s => ({ id: s.id, nom: s.name, debut: s.start, fin: s.end, minutes: slotLen(s) })),
    besoinsRestants: needsLeft, employes: empCtx
  };
  const prompt = `Construis les affectations de la semaine. Réponds uniquement par un JSON : {"assignments":{"<id employé>":{"mon":["<id créneau>"],"tue":[...]}}} (jours sans travail omis).
Règles impératives :
1. Pour chaque jour et chaque créneau, vise exactement besoinsRestants. Un écart d'une personne en plus ou en moins (tolérance ±${tol()}) est accepté seulement si c'est nécessaire pour respecter les heures de chacun ; ne descends jamais sous le besoin moins la tolérance, et jamais à 0 un créneau demandé à 1 personne.
2. N'affecte un employé que sur des créneaux listés dans jours[jour].allowed ; jamais un jour "indisponible" ni "horaire fixe".
3. Respecte doitTravailler et doitTravaillerCreneaux.
4. Créneaux entiers uniquement. Les créneaux d'une même personne le même jour doivent être collés, ou séparés par une seule coupure de ${S.settings.maxGapHours}h maximum. Chaque journée travaillée contient au moins un bloc entier de matin ou d'après-midi (créneau d'au moins ${S.settings.minDayHours}h : jamais seulement un petit créneau comme « Midi ») et dure ${S.settings.maxDayHours}h au maximum.
5. Le total de chaque employé (dejaPlaceMinutes + durée de tes créneaux) ne doit pas dépasser objectifMinutes. Reste en dessous si les besoins sont couverts : les heures restantes seront décidées ensuite.
Objectifs souples : répartir les jours travaillés sur toute la semaine, répartir équitablement les créneaux du soir et du week-end, respecter prefere / evite / notes.
Données :
${JSON.stringify(data)}`;
  let msgs = [{ role: 'system', content: 'Tu es un moteur de planification rigoureux. Tu réponds uniquement par un objet JSON valide.' }, { role: 'user', content: prompt }];
  let note = '';
  for (let i = 0; i < 3; i++) {
    onStatus && onStatus(`IA : tentative ${i + 1}/3…`);
    let raw;
    try { raw = await callGroq(msgs, { json: true, temperature: 0.3 }); }
    catch (e) { note = 'IA indisponible (' + e.message + ') : génération automatique.'; break; }
    const parsed = parseJSON(raw);
    if (!parsed) { msgs = [...msgs, { role: 'assistant', content: String(raw).slice(0, 2000) }, { role: 'user', content: 'Réponse illisible. Renvoie uniquement le JSON demandé.' }]; continue; }
    const plan = planFromAI(weekKey, parsed), v = validate(plan);
    if (planScore(v) <= planScore(best.v)) best = { plan, v, src: 'ia' };
    if (v.errors.length === 0) break;
    msgs = [...msgs, { role: 'assistant', content: JSON.stringify(parsed).slice(0, 6000) },
      { role: 'user', content: 'Ta proposition contient ces erreurs :\n- ' + v.errors.slice(0, 15).join('\n- ') + '\nCorrige-les et renvoie le JSON complet.' }];
  }
  if (best.src === 'auto' && !note) note = 'L\'IA n\'a pas fait mieux que le calculateur interne : c\'est lui qui a été retenu.';
  const added = completePlan(best.plan);
  if (added) note += (note ? ' ' : '') + `${added} créneau(x) ajouté(s) automatiquement ; les heures de chacun sont ajustées pile à leur objectif.`;
  return { plan: best.plan, src: best.src, note };
}

async function generateWeek() {
  if (S.busy) return;
  if (!slots().length) { S.status = 'Définissez d\'abord des créneaux horaires dans Admin.'; return C.render(); }
  if (!emps().length) { S.status = 'Aucun employé.'; return C.render(); }
  S.busy = true; S.status = 'Génération en cours…'; C.render();
  try {
    S.week = C.isoDate(C.mondayOf(new Date(S.week + 'T00:00:00')));
    const res = await aiGenerate(S.week, msg => { S.status = msg; const el = $('iaStatus'); if (el) el.textContent = msg; });
    res.plan.source = res.src; res.plan.note = res.note || '';
    S.plan = res.plan; S.status = '';
    const v = validate(S.plan);
    let m = `Proposition prête (${res.src === 'ia' ? 'IA' : 'calculateur interne'}). ` + (v.errors.length ? `⚠️ ${v.errors.length} point(s) ne respectent pas les règles, voir la liste sous le tableau.` : 'Toutes les règles obligatoires sont respectées.');
    if (res.note) m += '\n' + res.note;
    if (!slots().some(sl => C.DAYS.some(d => ((S.needs[sl.id] || {})[d.key] || 0) > 0))) m += '\nAucun besoin défini (onglet Besoins) : le planning est construit à partir des heures de chacun.';
    m += remainingText(v);
    S.chat.push({ role: 'assistant', content: m });
  } catch (e) { S.status = '⚠️ ' + e.message; }
  S.busy = false; C.render();
}
function remainingText(v) {
  const list = emps().filter(e => v.remaining[e.id] != null && v.remaining[e.id] >= 15).map(e => `${e.name} (${C.hoursFmt(v.remaining[e.id] / 60)})`);
  if (!list.length) return '';
  return `\n\nIl reste des heures à placer pour : ${list.join(', ')}.\nOù voulez-vous les mettre ? (ex. « Léa le samedi matin ») — ou cliquez sur « Compléter automatiquement ».`;
}

async function applyPlan(silentOverwrite) {
  const p = S.plan; if (!p) return;
  const v = validate(p);
  if (v.errors.length && !silentOverwrite && !confirm(`Il reste ${v.errors.length} point(s) non conformes. Appliquer quand même ?`)) return;
  const ow = $('iaOverwrite'), overwrite = silentOverwrite ? true : (ow ? ow.checked : true);
  const sch = C.state.schedule;
  if (!sch[p.weekKey]) sch[p.weekKey] = {};
  let n = 0;
  emps().forEach(e => {
    const empS = sch[p.weekKey][e.id] = sch[p.weekKey][e.id] || {};
    C.DAYS.forEach(d => {
      if (!overwrite && empS[d.key]) return;
      const obj = dayObjFromSegs(planSegs(p, e.id, d.key));
      obj.posteId = (empS[d.key] && empS[d.key].posteId) || '';
      empS[d.key] = obj; n++;
    });
  });
  await C.saveJSON('schedule', sch);
  S.chat.push({ role: 'assistant', content: `✅ Planning appliqué (${n} cases écrites) pour la semaine du ${fr(p.weekKey)}.` });
  S.plan = null;
  C.render();
}

/* ============================================================
   CHAT
   ============================================================ */
function briefRule(r) {
  return { type: r.type, niveau: r.level, jours: r.days, du: r.from, au: r.to, creneaux: r.slotIds.map(slotName), debut: r.start, fin: r.end, note: r.note };
}
function planBrief(p) {
  const v = validate(p), dates = weekDates(p.weekKey);
  return {
    semaine: p.weekKey, source: p.source,
    lignes: emps().map(e => ({ employe: e.name, jours: Object.fromEntries(C.DAYS.map(d => [d.key, planSegs(p, e.id, d.key).map(s => s.start + '-' + s.end).join(' + ') || 'repos'])), heuresPlacees: C.hoursFmt(v.total[e.id] / 60), objectif: targetMin(e, dates) == null ? null : C.hoursFmt(targetMin(e, dates) / 60) })),
    erreurs: v.errors.slice(0, 15),
    heuresRestantes: Object.fromEntries(emps().filter(e => v.remaining[e.id] != null && v.remaining[e.id] >= 15).map(e => [e.name, C.hoursFmt(v.remaining[e.id] / 60)]))
  };
}
function chatSystem() {
  const sl = slots();
  const data = {
    dateDuJour: C.isoDate(new Date()), semaineAffichee: S.week,
    creneaux: sl.map(s => ({ nom: s.name, debut: s.start, fin: s.end })),
    besoins: sl.map(s => ({ creneau: s.name, ...Object.fromEntries(C.DAYS.map(d => [d.key, (S.needs[s.id] || {})[d.key] || 0])) })),
    employes: emps().map(e => ({ nom: e.name, objectifHeuresSemaine: e.weeklyHours ?? null, regles: rulesOf(e.id).map(briefRule) })),
    propositionEnCours: S.plan ? planBrief(S.plan) : null,
    actionsEnAttente: S.pending || null
  };
  return `Tu es l'assistant de planification d'une pointeuse. Tu aides le responsable à enregistrer les contraintes de son équipe, régler les besoins en personnel et construire le planning.
Tu réponds TOUJOURS par un objet JSON : {"reply":"réponse courte en français","actions":[...]}.
Tu ne modifies jamais rien toi-même : tu proposes des "actions" que le responsable confirme (oui) ou fait modifier. S'il demande de changer les actions en attente, renvoie la liste complète corrigée. Pour une simple question, actions = [].
Si des heures restent à placer (propositionEnCours.heuresRestantes) et que le responsable précise où, utilise edit_plan pour ajouter ces créneaux (donne la liste complète des créneaux du jour de la personne).
Types d'actions :
- {"type":"add_rule","employee":"Nom","rule":{"type":"conge|absent|fixe|travaille|non_travaille|pref","level":"strict|souhait","days":["mon"],"from":"AAAA-MM-JJ","to":"AAAA-MM-JJ","slots":["Matin"],"start":"HH:MM","end":"HH:MM","breakStart":"HH:MM","breakEnd":"HH:MM","note":"texte"}}
  (conge/absent : from et to ; fixe : days + start + end ; travaille / non_travaille : days et/ou slots ; pref : note libre)
- {"type":"set_need","slot":"Matin","days":["mon","tue"] ou ["all"],"count":2}
- {"type":"generate"}  (génère une proposition pour la semaine affichée)
- {"type":"edit_plan","employee":"Nom","day":"mon","slots":["Matin","Après-midi"]}  (modifie la proposition en cours ; slots vide = repos)
- {"type":"fill_remaining"}  (complète automatiquement les heures restantes)
- {"type":"apply_plan"}  (applique la proposition au planning)
Clés des jours : mon,tue,wed,thu,fri,sat,sun. Dates AAAA-MM-JJ (déduis l'année de dateDuJour). Utilise les noms exacts des employés et des créneaux.
Données actuelles :
${JSON.stringify(data)}`;
}
function describeAction(a) {
  switch (a.type) {
    case 'add_rule': { const r = normalizeRule(a.rule || {}, 'admin'); return `${a.employee} : ` + (typeof r === 'string' ? '⚠️ ' + r : describeRule(r)); }
    case 'set_need': return `Besoin « ${a.slot} » : ${a.count} personne(s) — ${(a.days || [a.day]).join(', ')}`;
    case 'generate': return `Générer le planning de la semaine du ${fr(C.isoDate(C.mondayOf(new Date(S.week + 'T00:00:00'))))}`;
    case 'edit_plan': return `Proposition : ${a.employee}, ${DAYS_FULL[dayKeyOf(a.day)] || a.day} → ${(a.slots || []).join(' + ') || 'repos'}`;
    case 'fill_remaining': return 'Compléter automatiquement les heures restantes';
    case 'apply_plan': return 'Appliquer la proposition au planning';
    default: return 'Action inconnue : ' + a.type;
  }
}
async function runAction(a) {
  switch (a.type) {
    case 'add_rule': {
      const e = findEmp(a.employee); if (!e) return `Employé introuvable : ${a.employee}`;
      const r = normalizeRule(a.rule || {}, 'admin'); if (typeof r === 'string') return `${e.name} : ${r}`;
      rulesOf(e.id).push(r); await saveRules(e.id); return `Règle ajoutée pour ${e.name}`;
    }
    case 'set_need': {
      const sid = slotIdOf(a.slot); if (!sid) return `Créneau introuvable : ${a.slot}`;
      let days = (a.days || [a.day]).map(x => norm(x) === 'all' || norm(x) === 'tous' ? 'all' : dayKeyOf(x));
      if (days.includes('all')) days = C.DAYS.map(d => d.key);
      days = days.filter(Boolean);
      const c = Math.max(0, parseInt(a.count, 10) || 0);
      S.needs[sid] = S.needs[sid] || {}; days.forEach(d => { S.needs[sid][d] = c; });
      await C.saveJSON('ia_needs', S.needs); return `Besoin mis à jour : ${slotName(sid)}`;
    }
    case 'generate': S.pending = null; await generateWeek(); return 'Génération lancée';
    case 'edit_plan': {
      if (!S.plan) return 'Aucune proposition en cours : générez-la d\'abord.';
      const e = findEmp(a.employee), dk = dayKeyOf(a.day); if (!e || !dk) return 'Employé ou jour introuvable.';
      if (S.plan.fixed[e.id][dk]) return `${e.name} a un horaire fixe ce jour-là.`;
      S.plan.assign[e.id][dk] = [...new Set((a.slots || []).map(slotIdOf).filter(Boolean))];
      if (S.plan.adj && S.plan.adj[e.id]) delete S.plan.adj[e.id][dk];
      S.plan.source += S.plan.source.includes('modifié') ? '' : ' (modifié)';
      return `Proposition modifiée : ${e.name}, ${DAYS_FULL[dk]}`;
    }
    case 'fill_remaining': {
      if (!S.plan) return 'Aucune proposition en cours.';
      return `${completePlan(S.plan)} créneau(x) ajouté(s), heures ajustées`;
    }
    case 'apply_plan': await applyPlan(true); return 'Planning appliqué';
    default: return 'Action inconnue';
  }
}
function chatInner() {
  const msgs = S.chat.map(m => `<div class="ia-msg ${m.role}${m.error ? ' err' : ''}">${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('')
    || `<div class="subtle" style="padding:6px 2px;">Écrivez une demande, par exemple : « Léa est en congé du 3 au 9 novembre », « il faut 2 personnes le samedi matin », « Tom ne travaille jamais le mercredi ».</div>`;
  const busy = S.busy ? '<div class="ia-msg assistant">…</div>' : '';
  const pend = S.pending && S.pending.length ? `<div class="ia-pending"><div class="subtle" style="margin-bottom:6px;">Actions proposées :</div><ul>${S.pending.map(a => `<li>${esc(describeAction(a))}</li>`).join('')}</ul><div class="field-row"><button class="btn" onclick="iaConfirm()">✓ Oui, appliquer</button><button class="btn secondary" onclick="iaCancelPending()">Annuler</button></div><div class="subtle">Ou écrivez ce que vous voulez modifier.</div></div>` : '';
  return `<div id="iaChatLog" class="ia-log">${msgs}${busy}</div>${pend}`;
}
function refreshChat() {
  const h = $('iaChatInner'); if (!h) return;
  h.innerHTML = chatInner();
  const l = $('iaChatLog'); if (l) l.scrollTop = l.scrollHeight;
}
export async function iaSend() {
  const inp = $('iaChatInput'); if (!inp) return;
  const text = inp.value.trim(); if (!text || S.busy) return;
  inp.value = '';
  if (S.pending && /^(oui|ok|okay|d'accord|dac|vas-y|go|valide|confirme)\b/i.test(text)) { S.chat.push({ role: 'user', content: text }); return iaConfirm(); }
  S.chat.push({ role: 'user', content: text }); S.busy = true; refreshChat();
  try {
    const hist = S.chat.slice(-12).map(m => ({ role: m.role, content: m.role === 'assistant' ? (m.raw || m.content) : m.content }));
    const raw = await callGroq([{ role: 'system', content: chatSystem() }, ...hist], { json: true, temperature: 0.2 });
    const p = parseJSON(raw) || { reply: String(raw), actions: [] };
    S.chat.push({ role: 'assistant', content: p.reply || '…', raw });
    S.pending = Array.isArray(p.actions) && p.actions.length ? p.actions : null;
  } catch (e) { S.chat.push({ role: 'assistant', content: '⚠️ ' + e.message, error: true }); }
  S.busy = false; refreshChat();
}
export async function iaConfirm() {
  if (!S.pending) return;
  const acts = S.pending; S.pending = null; S.busy = true; refreshChat();
  const out = [];
  for (const a of acts) { try { out.push('• ' + await runAction(a)); } catch (e) { out.push('• ⚠️ ' + e.message); } }
  S.busy = false;
  S.chat.push({ role: 'assistant', content: '✅ Fait :\n' + out.join('\n') });
  const v = S.plan ? validate(S.plan) : null;
  if (v && acts.some(a => a.type === 'edit_plan' || a.type === 'fill_remaining')) { const rt = remainingText(v).trim(); if (rt) S.chat.push({ role: 'assistant', content: rt }); }
  C.render();
}
export function iaCancelPending() { S.pending = null; S.chat.push({ role: 'assistant', content: 'D\'accord, j\'annule. Que souhaitez-vous modifier ?' }); refreshChat(); }

/* ============================================================
   ONGLET ÉQUIPE
   ============================================================ */
export function renderEquipe() {
  if (!C) return '';
  if (C.canEditPlanning()) return renderEditor();
  return renderPublic();
}

/* ----- accès employé (code personnel) ----- */
function renderPublic() {
  const lock = `
    <div class="lock-inline">
      <input type="password" id="planningPwInput" placeholder="Code planning ou admin">
      <button class="btn secondary" onclick="tryPlanningLogin()">Gérer l'équipe</button>
    </div>
    <div id="planningLoginErr" style="color:var(--bad); font-size:.78rem; margin-bottom:10px;"></div>`;
  const emp = emps().find(e => e.id === S.self.empId);
  if (!emp) {
    const dots = [0, 1, 2, 3].map(i => `<div class="dot ${i < S.self.buf.length ? 'filled' : ''}"></div>`).join('');
    const grid = ['1','2','3','4','5','6','7','8','9','fn_clear','0','fn_back'].map(k => {
      if (k === 'fn_clear') return `<button class="fn" onclick="iaPinClear()">Effacer</button>`;
      if (k === 'fn_back') return `<button class="fn" onclick="iaPinBack()">⌫</button>`;
      return `<button onclick="iaPinPress('${k}')">${k}</button>`;
    }).join('');
    return `${lock}
      <h2 class="section-title">Mon espace</h2>
      <div class="punch-wrap">
        <div class="card-perf">
          <div class="pin-dots ${S.self.err ? 'shake' : ''}">${dots}</div>
          <div class="subtle">Entrez votre code personnel pour saisir vos congés et vos préférences</div>
          ${S.self.err ? `<div style="color:var(--bad); font-size:.78rem; margin-top:8px;">${esc(S.self.err)}</div>` : ''}
        </div>
        <div class="keypad">${grid}</div>
      </div>`;
  }
  const rs = rulesOf(emp.id);
  const mine = r => r.by === 'employee';
  const item = r => `<li><div class="info"><b>${esc(describeRule(r))}</b><span>${mine(r) ? 'saisi par vous' : 'défini par la direction'}</span></div><div class="actions">${mine(r) ? `<button onclick="iaDeleteRule('${emp.id}','${r.id}')">Supprimer</button>` : ''}</div></li>`;
  const abs = rs.filter(r => r.type === 'conge' || r.type === 'absent');
  const prefs = rs.filter(r => ['travaille', 'non_travaille', 'pref'].includes(r.type));
  const fixed = rs.filter(r => r.type === 'fixe');
  return `${lock}
    <h2 class="section-title">Mon espace — ${esc(emp.name)}</h2>
    <div class="filters"><button class="btn secondary" onclick="iaLogout()">Changer de personne</button></div>
    <div class="card"><div class="subtle" style="margin-bottom:8px;">Mes congés et absences</div>
      <ul class="emp-list">${abs.map(item).join('') || '<li class="subtle" style="border:none;">Aucun pour l\'instant.</li>'}</ul></div>
    <div class="card"><div class="subtle" style="margin-bottom:8px;">Mes préférences (respectées autant que possible)</div>
      <ul class="emp-list">${prefs.map(item).join('') || '<li class="subtle" style="border:none;">Aucune pour l\'instant.</li>'}</ul></div>
    ${fixed.length ? `<div class="card"><div class="subtle" style="margin-bottom:8px;">Horaires fixes</div><ul class="emp-list">${fixed.map(item).join('')}</ul></div>` : ''}
    <h2 class="section-title">Ajouter</h2>
    ${ruleForm('employee', emp.id)}`;
}
export function iaPinPress(d) {
  if (S.self.buf.length >= 4) return;
  S.self.buf += d; S.self.err = '';
  if (S.self.buf.length === 4) {
    const e = emps().find(x => x.code === S.self.buf);
    if (e) { S.self.empId = e.id; S.self.buf = ''; }
    else { S.self.err = 'Code inconnu'; C.render(); setTimeout(() => { S.self.buf = ''; S.self.err = ''; C.render(); }, 1400); return; }
  }
  C.render();
}
export function iaPinBack() { S.self.buf = S.self.buf.slice(0, -1); C.render(); }
export function iaPinClear() { S.self.buf = ''; C.render(); }
export function iaLogout() { S.self.empId = null; S.self.buf = ''; C.render(); }

/* ----- espace responsable ----- */
function renderEditor() {
  const tabs = [['needs', 'Besoins'], ['rules', 'Contraintes'], ['gen', 'Planning IA']];
  const seg = `<div class="seg ia-seg">${tabs.map(([k, l]) => `<button class="${S.sub === k ? 'active' : ''}" onclick="iaSub('${k}')">${l}</button>`).join('')}</div>`;
  const body = S.sub === 'needs' ? viewNeeds() : S.sub === 'rules' ? viewRules() : viewGen();
  return `${seg}<div style="height:14px"></div>${body}`;
}
export function iaSub(k) { S.sub = k; C.render(); }

function viewNeeds() {
  const sl = slots();
  if (!sl.length) return `<div class="empty">Aucun créneau défini.<br>Ajoutez-en dans l'onglet Admin (Créneaux horaires).</div>`;
  const rows = sl.map(s => `<tr><td class="name">${esc(s.name)}<br><span class="subtle mono">${s.start}–${s.end}</span></td>${C.DAYS.map(d => `<td><input type="number" min="0" max="50" class="ia-num" id="need_${s.id}_${d.key}" value="${(S.needs[s.id] || {})[d.key] || 0}"></td>`).join('')}</tr>`).join('');
  const st = S.settings;
  return `
    <h2 class="section-title">Personnes nécessaires par créneau</h2>
    <div class="card scroll-x"><table class="sched"><thead><tr><th></th>${C.DAYS.map(d => `<th>${d.label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <h2 class="section-title">Règles d'une journée</h2>
    <div class="card">
      <div class="field-row">
        <div class="time-field"><span class="subtle time-field-label">Bloc minimum : matin ou après-midi entier (h)</span><input type="number" min="1" max="12" id="iaMinDay" value="${st.minDayHours}"></div>
        <div class="time-field"><span class="subtle time-field-label">Journée maximum (h)</span><input type="number" min="1" max="16" id="iaMaxDay" value="${st.maxDayHours}"></div>
        <div class="time-field"><span class="subtle time-field-label">Coupure maximum (h)</span><input type="number" min="0" max="8" id="iaMaxGap" value="${st.maxGapHours}"></div>
        <div class="time-field"><span class="subtle time-field-label">Tolérance personnes par créneau (±)</span><input type="number" min="0" max="3" id="iaTol" value="${st.needTol}"></div>
      </div>
      <div class="subtle" style="margin-bottom:10px;">Un employé qui travaille fait toujours au moins un créneau d'au moins cette durée (ex. tout le matin ou tout l'après-midi), jamais « Midi » seul. Le planning est toujours proposé, même s'il reste des trous : ils sont listés.</div>
      <button class="btn" onclick="iaSaveNeeds()">Enregistrer</button>
      <span id="iaNeedsMsg" class="subtle" style="margin-left:10px;color:var(--good);"></span>
    </div>`;
}
export async function iaSaveNeeds() {
  const needs = {};
  slots().forEach(s => { needs[s.id] = {}; C.DAYS.forEach(d => { const v = parseInt($('need_' + s.id + '_' + d.key).value, 10); needs[s.id][d.key] = isNaN(v) || v < 0 ? 0 : v; }); });
  const num = (id, def) => { const v = parseFloat($(id).value); return isNaN(v) || v <= 0 ? def : v; };
  S.needs = needs;
  S.settings = { minDayHours: num('iaMinDay', 3), maxDayHours: num('iaMaxDay', 10), maxGapHours: Math.max(0, parseFloat($('iaMaxGap').value) || 0), needTol: Math.max(0, Math.min(3, isNaN(parseInt($('iaTol').value, 10)) ? 1 : parseInt($('iaTol').value, 10))) };
  await C.saveJSON('ia_needs', S.needs);
  await C.saveJSON('ia_settings', S.settings);
  const m = $('iaNeedsMsg'); if (m) m.textContent = 'Enregistré ✓';
}

function viewRules() {
  if (!emps().length) return `<div class="empty">Aucun employé.<br>Ajoutez des employés dans l'onglet Admin.</div>`;
  let e = emps().find(x => x.id === S.ruleEmp); if (!e) { e = emps()[0]; S.ruleEmp = e.id; }
  const rs = rulesOf(e.id);
  return `
    <h2 class="section-title">Contraintes par employé</h2>
    <div class="filters"><select onchange="iaPickEmp(this.value)">${emps().map(x => `<option value="${x.id}" ${x.id === e.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="card"><ul class="emp-list">${rs.map(r => `<li><div class="info"><b>${esc(describeRule(r))}</b><span>${r.by === 'employee' ? 'saisi par l\'employé' : 'direction'}</span></div><div class="actions"><button onclick="iaDeleteRule('${e.id}','${r.id}')">Supprimer</button></div></li>`).join('') || '<li class="subtle" style="border:none;">Aucune contrainte pour cet employé.</li>'}</ul></div>
    <h2 class="section-title">Ajouter une contrainte</h2>
    ${ruleForm('admin', e.id)}`;
}
export function iaPickEmp(id) { S.ruleEmp = id; C.render(); }
export async function iaDeleteRule(empId, ruleId) {
  const r = rulesOf(empId).find(x => x.id === ruleId); if (!r) return;
  if (!C.canEditPlanning() && r.by !== 'employee') return;
  S.rules[empId] = rulesOf(empId).filter(x => x.id !== ruleId);
  await saveRules(empId); C.render();
}

function ruleForm(mode, empId) {
  const types = mode === 'employee' ? ['conge', 'absent', 'travaille', 'non_travaille', 'pref'] : TYPES;
  const lab = mode === 'employee' ? TYPE_LABEL_EMP : TYPE_LABEL_ADMIN;
  const dayChk = C.DAYS.map(d => `<label class="ia-chk"><input type="checkbox" class="ir-day" value="${d.key}"> ${d.label}</label>`).join('');
  const slotChk = slots().map(s => `<label class="ia-chk"><input type="checkbox" class="ir-slot" value="${s.id}"> ${esc(s.name)}</label>`).join('') || '<span class="subtle">Aucun créneau défini.</span>';
  const tf = (id, label) => `<div class="time-field"><span class="subtle time-field-label">${label}</span><input type="time" id="${id}"></div>`;
  return `
    <div class="card" id="iaRuleForm">
      <div class="field-row">
        <select id="ir_type" onchange="iaRuleTypeChange()">${types.map(t => `<option value="${t}">${lab[t]}</option>`).join('')}</select>
        ${mode === 'admin' ? `<span class="ir-sec" data-sec="level"><select id="ir_level"><option value="strict">Obligatoire</option><option value="souhait">Souhaité</option></select></span>` : ''}
      </div>
      <div class="field-row ir-sec" data-sec="dates">
        <div class="time-field"><span class="subtle time-field-label">Du</span><input type="date" id="ir_from"></div>
        <div class="time-field"><span class="subtle time-field-label">Au</span><input type="date" id="ir_to"></div>
      </div>
      <div class="field-row ir-sec" data-sec="days"><span class="subtle" style="width:100%;">Jours (vide = tous)</span>${dayChk}</div>
      <div class="field-row ir-sec" data-sec="slots"><span class="subtle" style="width:100%;">Créneaux (vide = toute la journée)</span>${slotChk}</div>
      <div class="field-row ir-sec" data-sec="fixed">${tf('ir_start', 'Arrivée')}${tf('ir_end', 'Départ')}${tf('ir_bstart', 'Début coupure (option)')}${tf('ir_bend', 'Fin coupure (option)')}</div>
      <div class="field-row"><input type="text" id="ir_note" placeholder="Note (facultatif)"></div>
      <div id="irErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
      <button class="btn" onclick="iaSaveRule('${empId}','${mode}')">Ajouter</button>
    </div>`;
}
export function iaRuleTypeChange() {
  const sel = $('ir_type'); if (!sel) return;
  const map = { conge: ['dates'], absent: ['dates'], fixe: ['dates', 'days', 'fixed'], travaille: ['dates', 'days', 'slots', 'level'], non_travaille: ['dates', 'days', 'slots', 'level'], pref: [] };
  const show = map[sel.value] || [];
  document.querySelectorAll('#iaRuleForm .ir-sec').forEach(el => { el.style.display = show.includes(el.dataset.sec) ? '' : 'none'; });
}
export async function iaSaveRule(empId, mode) {
  const g = id => $(id) ? $(id).value : '';
  const raw = {
    type: g('ir_type'), level: mode === 'employee' ? 'souhait' : g('ir_level'),
    days: [...document.querySelectorAll('.ir-day:checked')].map(x => x.value),
    slotIds: [...document.querySelectorAll('.ir-slot:checked')].map(x => x.value),
    from: g('ir_from'), to: g('ir_to'), start: g('ir_start'), end: g('ir_end'), breakStart: g('ir_bstart'), breakEnd: g('ir_bend'),
    note: g('ir_note').trim()
  };
  const r = normalizeRule(raw, mode === 'employee' ? 'employee' : 'admin');
  if (typeof r === 'string') { $('irErr').textContent = r; return; }
  rulesOf(empId).push(r); await saveRules(empId); C.render();
}

/* ----- génération + chat ----- */
function viewGen() {
  const monday = C.mondayOf(new Date(S.week + 'T00:00:00')), wk = C.isoDate(monday);
  const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
  const label = `${monday.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })} – ${sunday.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  const hasKeys = enabledKeys().length > 0;
  let planHtml = `<div class="subtle" style="margin-bottom:14px;">Aucune proposition pour cette semaine. Cliquez sur « Générer » ou demandez-le dans le chat.</div>`;
  if (S.plan && S.plan.weekKey === wk) planHtml = planView(S.plan);
  return `
    <h2 class="section-title">Planning par IA</h2>
    <div class="day-view-nav">
      <button onclick="iaShiftWeek(-1)">◀</button>
      <span class="day-label">Semaine du ${label}</span>
      <button onclick="iaShiftWeek(1)">▶</button>
    </div>
    <div class="field-row" style="justify-content:center;">
      <button class="btn" onclick="iaGenerate()" ${S.busy ? 'disabled' : ''}>✨ Générer la semaine</button>
    </div>
    ${hasKeys ? '' : `<div class="subtle" style="text-align:center;margin-bottom:8px;">Aucune clé Groq active : seul le calculateur interne sera utilisé (Admin → Intelligence artificielle).</div>`}
    <div id="iaStatus" class="subtle" style="text-align:center;margin-bottom:12px;">${esc(S.status)}</div>
    ${planHtml}
    <h2 class="section-title">Assistant</h2>
    <div class="card ia-chat">
      <div id="iaChatInner">${chatInner()}</div>
      <div class="field-row" style="margin:10px 0 0;">
        <input type="text" id="iaChatInput" placeholder="Écrivez votre demande…" onkeydown="if(event.key==='Enter')iaSend()">
        <button class="btn" onclick="iaSend()">Envoyer</button>
      </div>
    </div>`;
}
function planView(p) {
  const dates = weekDates(p.weekKey), v = validate(p);
  const rows = emps().map(e => {
    const cells = C.DAYS.map((d, i) => {
      const inf = dayInfo(e.id, dates[i], d.key), segs = planSegs(p, e.id, d.key);
      if (inf.off) return `<td class="cell repos conge">${inf.off === 'conge' ? 'Congé' : 'Absent'}</td>`;
      if (!segs.length) return `<td class="cell repos">Repos</td>`;
      return `<td class="cell">${p.fixed[e.id][d.key] ? '📌 ' : ''}${segs.map(s => `${s.start}–${s.end}`).join(' · ')}</td>`;
    }).join('');
    const t = targetMin(e, dates), tot = v.total[e.id];
    return `<tr><td class="name">${esc(e.name)}</td>${cells}<td class="quota-target">${t == null ? '—' : C.hoursFmt(t / 60)}</td><td class="quota-total ${t == null ? '' : (tot === t ? 'quota-ok' : 'quota-under')}">${C.hoursFmt(tot / 60)}</td></tr>`;
  }).join('');
  const rem = Object.keys(v.remaining).length ? emps().filter(e => v.remaining[e.id] != null && v.remaining[e.id] >= 15) : [];
  return `
    <div class="subtle" style="margin-bottom:8px;">Proposition (${esc(p.source === 'ia' ? 'IA' : p.source.startsWith('auto') ? 'calculateur interne' : p.source)}) — 📌 = horaire fixe</div>
    <div class="card scroll-x"><table class="sched"><thead><tr><th></th>${C.DAYS.map((d, i) => `<th>${d.label}<br><span class="subtle" style="font-weight:400;">${dates[i].slice(8)}/${dates[i].slice(5, 7)}</span></th>`).join('')}<th>Objectif</th><th>Placé</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${v.errors.length ? `<div class="card ia-errors"><b>Trous et points à vérifier (${v.errors.length})</b><ul>${v.errors.slice(0, 20).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '<div class="subtle" style="color:var(--good);margin-bottom:10px;">✓ Toutes les règles obligatoires sont respectées.</div>'}
    ${v.tolerated.length ? `<div class="subtle" style="margin-bottom:10px;">Écarts tolérés (±${tol()} personne) : ${esc(v.tolerated.slice(0, 12).join(' · '))}${v.tolerated.length > 12 ? '…' : ''}</div>` : ''}
    ${v.warnings.length ? `<div class="subtle" style="margin-bottom:10px;">${v.warnings.slice(0, 8).map(esc).join('<br>')}</div>` : ''}
    ${rem.length ? `<div class="card"><b>Heures restantes à placer</b><div class="subtle" style="margin:6px 0 10px;">${rem.map(e => `${esc(e.name)} : ${C.hoursFmt(v.remaining[e.id] / 60)}`).join(' · ')}<br>Dites-moi dans le chat où les mettre, ou :</div><button class="btn secondary" onclick="iaFill()">Compléter automatiquement</button></div>` : ''}
    <div class="field-row" style="align-items:center;">
      <button class="btn" onclick="iaApplyPlan()">✓ Appliquer au planning</button>
      <button class="btn secondary" onclick="iaDiscardPlan()">Annuler la proposition</button>
      <label class="ia-chk"><input type="checkbox" id="iaOverwrite" checked> Remplacer l'existant</label>
    </div>`;
}
export function iaShiftWeek(delta) {
  const d = new Date(S.week + 'T00:00:00'); d.setDate(d.getDate() + delta * 7); S.week = C.isoDate(d); S.plan = null; C.render();
}
export function iaGenerate() { generateWeek(); }
export function iaApplyPlan() { applyPlan(false); }
export function iaDiscardPlan() { S.plan = null; C.render(); }
export function iaFill() {
  if (!S.plan) return;
  const n = completePlan(S.plan);
  S.chat.push({ role: 'assistant', content: `${n} créneau(x) ajouté(s) automatiquement.` + remainingText(validate(S.plan)) });
  C.render();
}

/* ============================================================
   ADMIN : clés Groq + modèle
   ============================================================ */
const mask = k => k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••';
export function renderAdminIA() {
  if (!C) return '';
  const list = S.keys.map(k => {
    const t = S.keyTest[k.id];
    const badge = t ? `<span style="color:${t.ok ? 'var(--good)' : 'var(--bad)'};">${esc(t.msg)}</span>` : '';
    return `<div class="poste-admin-row">
      <span class="poste-dot" style="background:${k.enabled !== false ? 'var(--good)' : 'var(--muted)'}"></span>
      <span class="pa-name">${esc(k.name)} <span class="subtle mono">${esc(mask(k.key))}</span> <span class="subtle">${badge}</span></span>
      <button class="btn secondary" onclick="iaToggleKey('${k.id}')" style="padding:5px 10px; font-size:.72rem;">${k.enabled !== false ? 'Désactiver' : 'Activer'}</button>
      <button class="btn danger" onclick="iaDeleteKey('${k.id}')" style="padding:5px 10px; font-size:.72rem;">Suppr.</button>
    </div>`;
  }).join('') || '<div class="subtle">Aucune clé enregistrée.</div>';
  return `
    <h2 class="section-title">Intelligence artificielle (Groq)</h2>
    <div class="card">
      <p class="subtle" style="margin-bottom:12px;">Ajoutez autant de clés API Groq que vous voulez. Quand une clé atteint sa limite, l'application passe automatiquement à la suivante. Les clés sont stockées dans votre base Firestore et lisibles par l'application.</p>
      ${list}
      <div class="divider"></div>
      <textarea id="iaKeysBulk" rows="4" class="ia-area" placeholder="Une clé par ligne (gsk_...)&#10;ou avec un nom :  Compte Sam = gsk_..."></textarea>
      <div class="field-row" style="margin-top:10px;">
        <button class="btn" onclick="iaAddKeys()">+ Ajouter les clés</button>
        <button class="btn secondary" onclick="iaTestKeys()">Tester les clés</button>
      </div>
      <div class="divider"></div>
      <div class="field-row">
        <input type="text" id="iaModel" value="${esc(S.model)}" placeholder="Modèle Groq (ex : ${DEFAULT_MODEL})">
        <button class="btn secondary" onclick="iaSaveModel()">Enregistrer le modèle</button>
      </div>
      <div id="iaAdminMsg" class="subtle">${esc(S.adminMsg)}</div>
    </div>`;
}
export async function iaAddKeys() {
  const txt = $('iaKeysBulk').value; let added = 0;
  txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    let name = '', key = line;
    const m = line.match(/^(.*?)\s*[=:]\s*(\S{16,})$/);
    if (m) { name = m[1].trim(); key = m[2]; }
    if (key.length < 16 || /\s/.test(key) || S.keys.some(k => k.key === key)) return;
    S.keys.push({ id: C.uid(), name: name || 'Clé ' + (S.keys.length + 1), key, enabled: true }); added++;
  });
  await C.saveJSON('ia_keys', S.keys);
  S.adminMsg = added ? `${added} clé(s) ajoutée(s) ✓` : 'Aucune nouvelle clé valide trouvée.';
  C.render();
}
export async function iaToggleKey(id) { const k = S.keys.find(x => x.id === id); if (!k) return; k.enabled = k.enabled === false; await C.saveJSON('ia_keys', S.keys); C.render(); }
export async function iaDeleteKey(id) {
  if (!confirm('Supprimer cette clé ?')) return;
  S.keys = S.keys.filter(x => x.id !== id); await C.saveJSON('ia_keys', S.keys); C.render();
}
export async function iaSaveModel() {
  const v = $('iaModel').value.trim() || DEFAULT_MODEL;
  S.model = v; await C.saveJSON('ia_model', v); S.adminMsg = 'Modèle enregistré ✓'; C.render();
}
export async function iaTestKeys() {
  S.adminMsg = 'Test en cours…'; const el = $('iaAdminMsg'); if (el) el.textContent = S.adminMsg;
  let modelOk = null;
  for (const k of S.keys) {
    try {
      const r = await fetch(GROQ_MODELS_URL, { headers: { Authorization: 'Bearer ' + k.key } });
      if (r.ok) {
        const d = await r.json(); S.keyTest[k.id] = { ok: true, msg: '✓ valide' };
        if (modelOk == null) modelOk = (d.data || []).some(m => m.id === S.model);
      } else S.keyTest[k.id] = { ok: false, msg: '✗ erreur ' + r.status };
    } catch (e) { S.keyTest[k.id] = { ok: false, msg: '✗ ' + e.message }; }
  }
  S.adminMsg = modelOk === false ? `⚠️ Le modèle « ${S.model} » n'existe pas (plus) chez Groq : changez-le ci-dessus.` : (modelOk ? 'Test terminé ✓ (modèle disponible)' : 'Test terminé.');
  C.render();
}

/* appelé par app.js après chaque rendu */
export function afterRender() {
  if ($('ir_type')) iaRuleTypeChange();
  const l = $('iaChatLog'); if (l) l.scrollTop = l.scrollHeight;
}

/* fonctions utilisées par les onclick="" du HTML */
if (typeof window !== 'undefined') {
  Object.assign(window, {
    iaSub, iaSaveNeeds, iaPickEmp, iaDeleteRule, iaSaveRule, iaRuleTypeChange,
    iaShiftWeek, iaGenerate, iaApplyPlan, iaDiscardPlan, iaFill, iaSend, iaConfirm, iaCancelPending,
    iaPinPress, iaPinBack, iaPinClear, iaLogout,
    iaAddKeys, iaToggleKey, iaDeleteKey, iaSaveModel, iaTestKeys
  });
}

/* pour les tests */
export const _test = { adjustToTarget, completePlan, aiGenerate, solve, validate, normalizeRule, fillRemaining, S, planSegs, dayObjFromSegs, targetMin, planFromAI, parseJSON };
