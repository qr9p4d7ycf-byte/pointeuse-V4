/* ============================================================
   FIREBASE
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBrGRdJKmFY5Llvv2WLZOC_Ok2FnlBKmaA",
  authDomain: "pointeuse-hulotte.firebaseapp.com",
  projectId: "pointeuse-hulotte",
  storageBucket: "pointeuse-hulotte.firebasestorage.app",
  messagingSenderId: "840258471845",
  appId: "1:840258471845:web:3ccd2f6f230a84927b0a4c",
  measurementId: "G-54WMH9KBPM"
};
const fbApp = initializeApp(firebaseConfig);
/* experimentalForceLongPolling : évite un bug de connexion Firestore <-> Safari
   (blocage "due to access control checks" sur le canal temps réel par défaut) */
const db = initializeFirestore(fbApp, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});
const COLLECTION = 'pointeuse_data';

/* ============================================================
   STORAGE HELPERS
   ============================================================ */
const STORAGE_PREFIX = 'pointeuse_hulotte_';
async function loadJSON(key, fallback){
  try{
    const ref = doc(db, COLLECTION, STORAGE_PREFIX + key);
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data().value : fallback;
  }catch(e){ console.error('storage load error', e); return fallback; }
}
async function saveJSON(key, value){
  try{
    const ref = doc(db, COLLECTION, STORAGE_PREFIX + key);
    await setDoc(ref, { value });
    return true;
  }catch(e){ console.error('storage save error', e); return false; }
}

const DAYS = [
  {key:'mon', label:'Lun'}, {key:'tue', label:'Mar'}, {key:'wed', label:'Mer'},
  {key:'thu', label:'Jeu'}, {key:'fri', label:'Ven'}, {key:'sat', label:'Sam'}, {key:'sun', label:'Dim'}
];
const DEFAULT_SLOTS = [
  { id:'s1', name:'Matin', start:'08:00', end:'12:00' },
  { id:'s2', name:'Midi', start:'12:00', end:'14:00' },
  { id:'s3', name:'Après-midi', start:'14:00', end:'18:00' },
  { id:'s4', name:'Soir', start:'18:00', end:'22:00' }
];
function dayKeyForDate(d){ return DAYS[(d.getDay()+6)%7].key; }
/* lundi (00:00) de la semaine contenant d */
function mondayOf(d){
  const dt = new Date(d);
  dt.setHours(0,0,0,0);
  const diff = (dt.getDay()+6)%7;
  dt.setDate(dt.getDate()-diff);
  return dt;
}
/* clé de semaine = date ISO du lundi, ex "2026-01-05" */
function weekKeyForDate(d){ return isoDate(mondayOf(d)); }
/* récupère le jour planifié pour un employé à une date précise (quelle que soit la semaine) */
function getScheduleDay(empId, dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  const wKey = weekKeyForDate(d);
  const dayKey = dayKeyForDate(d);
  return ((state.schedule[wKey] || {})[empId] || {})[dayKey] || null;
}

/* segments de travail d'une journée, en tenant compte d'une coupure éventuelle */
function daySegments(day){
  if(!day || day.repos || !day.start || !day.end) return [];
  const hasBreak = day.breakStart && day.breakEnd
    && day.breakStart >= day.start && day.breakEnd <= day.end
    && day.breakStart < day.breakEnd;
  if(hasBreak){
    return [
      {start: day.start, end: day.breakStart},
      {start: day.breakEnd, end: day.end}
    ].filter(s=> s.start < s.end);
  }
  return [{start: day.start, end: day.end}];
}
function formatDayRange(day){
  return daySegments(day).map(s=>`${s.start}–${s.end}`).join(' · ');
}

/* ============================================================
   GLOBAL STATE
   ============================================================ */
let state = {
  tab: 'planning',
  consultationMode: false, // true = lien "à distance" (pas de pointage)
  employees: [],       // [{id,name,code}]
  schedule: {},         // {weekKey(lundi ISO): {employeeId: {mon:{start,end,repos},...}}}
  adminConfig: null,     // {password}
  planningConfig: null,  // {password}
  timeSlots: [],
  postes: [],
  dayView: { date: isoDate(new Date()) },
  planningWeek: { date: isoDate(new Date()) },
  isAdmin: false,
  isPlanningEditor: false,
  pinBuffer: '',
  pinLock: false,
  heures: { scope:'tous', period:'week', customStart:null, customEnd:null, data:null },
  heuresSelf: { unlockedEmployeeId: null, codeBuffer: '', error: '' },
  correction: { employeeId:null, date: null, monthKey:null, monthData:null }
};
function canEditPlanning(){ return state.isAdmin || state.isPlanningEditor; }

let IA = null; // module Équipe + IA (ia.js), chargé dynamiquement
const monthCache = {}; // key -> array (in-memory cache during session)

function monthKeyOf(dateObj){
  return dateObj.getFullYear() + '-' + String(dateObj.getMonth()+1).padStart(2,'0');
}
async function getMonthPunches(mk){
  if(monthCache[mk]) return monthCache[mk];
  const data = await loadJSON('punches_'+mk, []);
  monthCache[mk] = data;
  return data;
}
async function saveMonthPunches(mk, arr){
  monthCache[mk] = arr;
  await saveJSON('punches_'+mk, arr);
}

function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

function fmtTime(d){ return d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}); }
function fmtDate(d){ return d.toLocaleDateString('fr-FR', {weekday:'short', day:'2-digit', month:'short'}); }
function isoDate(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function hoursFmt(h){
  if(h==null) return '—';
  const sign = h<0 ? '-' : '';
  h = Math.abs(h);
  const hh = Math.floor(h);
  const mm = Math.round((h-hh)*60);
  return sign + hh + 'h' + String(mm).padStart(2,'0');
}

/* ============================================================
   INIT
   ============================================================ */
async function init(){
  const params = new URLSearchParams(location.search);
  state.consultationMode = (typeof window !== 'undefined' && window.FORCE_CONSULTATION === true) || params.get('mode') === 'consultation';
  state.tab = state.consultationMode ? 'planning' : 'pointage';

  state.employees = await loadJSON('employees', []);
  state.schedule = await loadJSON('schedule', {});
  /* Migration : l'ancien format stockait le planning directement par employé
     (un seul planning répété toutes les semaines). Toute clé qui n'est pas une
     date de lundi est considérée comme un ancien planning et est rapatriée
     dans la semaine en cours, pour ne rien perdre. */
  const isWeekKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k);
  const legacyEmpKeys = Object.keys(state.schedule).filter(k => !isWeekKey(k));
  if(legacyEmpKeys.length > 0){
    const wKey = weekKeyForDate(new Date());
    if(!state.schedule[wKey]) state.schedule[wKey] = {};
    legacyEmpKeys.forEach(empId=>{
      const legacyDays = state.schedule[empId];
      delete state.schedule[empId];
      if(!legacyDays || typeof legacyDays !== 'object') return;
      // ne pas écraser un planning déjà saisi pour cette semaine
      if(!state.schedule[wKey][empId]) state.schedule[wKey][empId] = {};
      DAYS.forEach(d=>{
        if(legacyDays[d.key] && !state.schedule[wKey][empId][d.key]){
          state.schedule[wKey][empId][d.key] = legacyDays[d.key];
        }
      });
    });
    await saveJSON('schedule', state.schedule);
    console.log('[Pointeuse] Ancien planning récupéré vers la semaine', wKey);
  }
  console.log('[Pointeuse] Version 3.3 · semaines en base :', Object.keys(state.schedule));
  state.adminConfig = await loadJSON('admin_config', null);
  state.planningConfig = await loadJSON('planning_config', null);
  state.timeSlots = await loadJSON('time_slots', DEFAULT_SLOTS);
  state.postes = await loadJSON('postes', []);
  try{
    IA = await import('./ia.js?v=33');
    await IA.initIA({
      get state(){ return state; },
      loadJSON, saveJSON, render, uid, isoDate, mondayOf, DAYS, hoursFmt, canEditPlanning
    });
  }catch(e){ console.error('[Pointeuse] Module Équipe/IA indisponible', e); IA = null; }
  tickClock();
  setInterval(tickClock, 1000);
  renderTabsNav();
  render();
}

function renderTabsNav(){
  const nav = document.getElementById('tabsNav');
  const tabs = [];
  if(!state.consultationMode){
    tabs.push({key:'pointage', label:'Pointage', icon:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'});
  }
  tabs.push({key:'planning', label:'Planning', icon:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'});
  if(IA && !state.consultationMode){
    tabs.push({key:'equipe', label:'Équipe', icon:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.2c2.6.2 4.5 2.2 4.5 5"/>'});
  }
  tabs.push({key:'heures', label:'Heures', icon:'<path d="M4 19V9M12 19V5M20 19v-7"/>'});
  tabs.push({key:'admin', label:'Admin', icon:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'});
  nav.innerHTML = tabs.map(t=>`
    <button data-tab="${t.key}" class="${state.tab===t.key?'active':''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${t.icon}</svg>
      ${t.label}
    </button>
  `).join('');
  nav.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTab(btn.dataset.tab));
  });
}
function tickClock(){
  const now = new Date();
  document.getElementById('liveTime').textContent = now.toLocaleTimeString('fr-FR');
  document.getElementById('liveDate').textContent = now.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
}
function switchTab(tab){
  if(tab==='pointage' && state.consultationMode) return;
  if(tab==='equipe' && (state.consultationMode || !IA)) return;
  state.tab = tab;
  document.querySelectorAll('#tabsNav button').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  render();
}

/* ============================================================
   RENDER ROOT
   ============================================================ */
function render(){
  const main = document.getElementById('mainArea');
  let html = '';
  if(state.isAdmin){
    html += `<div class="admin-banner"><span>🔓 Mode admin actif</span><button onclick="lockAdmin()">Verrouiller</button></div>`;
  } else if(state.isPlanningEditor){
    html += `<div class="admin-banner planning"><span>🔓 Modification du planning activée</span><button onclick="lockPlanningEditor()">Verrouiller</button></div>`;
  }
  if(state.tab === 'pointage' && state.consultationMode) state.tab = 'planning';
  if(state.tab === 'equipe' && (state.consultationMode || !IA)) state.tab = 'planning';
  if(state.tab === 'pointage') html += renderPointage();
  else if(state.tab === 'planning') html += renderPlanning();
  else if(state.tab === 'equipe') html += IA.renderEquipe();
  else if(state.tab === 'heures') html += renderHeures();
  else if(state.tab === 'admin') html += renderAdmin();
  main.innerHTML = html;
  if(IA){ try{ IA.afterRender(); }catch(e){ console.error(e); } }
  if(state.tab === 'heures'){
    if(state.isAdmin) attachHeuresHandlers();
    else if(state.heuresSelf.unlockedEmployeeId) calcSelfHeures();
  }
}

/* ============================================================
   TAB: POINTAGE
   ============================================================ */
function renderPointage(){
  let dotsHtml = '';
  for(let i=0;i<4;i++){
    dotsHtml += `<div class="dot ${i < state.pinBuffer.length ? 'filled':''}"></div>`;
  }
  const grid = ['1','2','3','4','5','6','7','8','9','fn_clear','0','fn_back'];
  const gridHtml = grid.map(k=>{
    if(k==='fn_clear') return `<button class="fn" onclick="pinClear()">Effacer</button>`;
    if(k==='fn_back') return `<button class="fn" onclick="pinBackspace()">⌫</button>`;
    return `<button onclick="pinPress('${k}')">${k}</button>`;
  }).join('');

  let resultHtml = '';
  if(state.lastPunchResult){
    const r = state.lastPunchResult;
    if(r.error){
      resultHtml = `<div class="stamp-result err"><div class="label">Erreur</div><div class="name">${r.error}</div></div>`;
    } else {
      resultHtml = `<div class="stamp-result ${r.type}">
        <div class="label">Pointage enregistré</div>
        <div class="name">${r.name}</div>
        <div class="type ${r.type}">${r.type==='in' ? 'ENTRÉE' : 'SORTIE'}</div>
        <div class="time mono">${r.time}</div>
      </div>`;
    }
  }

  return `
    <div class="punch-wrap">
      ${resultHtml ? resultHtml : `
      <div class="card-perf">
        <div class="pin-dots ${state.pinShake?'shake':''}" id="pinDots">${dotsHtml}</div>
        <div class="subtle">Entrez votre code personnel à 4 chiffres</div>
      </div>
      <div class="keypad">${gridHtml}</div>
      `}
    </div>
  `;
}

function pinPress(d){
  if(state.pinLock) return;
  if(state.pinBuffer.length >= 4) return;
  state.pinBuffer += d;
  if(state.pinBuffer.length === 4){
    state.pinLock = true;
    setTimeout(()=> submitPin(), 150);
  }
  render();
}
function pinBackspace(){
  state.pinBuffer = state.pinBuffer.slice(0,-1);
  render();
}
function pinClear(){
  state.pinBuffer = '';
  render();
}

async function submitPin(){
  const code = state.pinBuffer;
  const emp = state.employees.find(e=> e.code === code);
  if(!emp){
    state.pinShake = true;
    state.lastPunchResult = { error: 'Code inconnu' };
    render();
    setTimeout(()=>{ state.pinShake=false; state.lastPunchResult=null; state.pinBuffer=''; state.pinLock=false; render(); }, 1800);
    return;
  }
  const now = new Date();
  const mk = monthKeyOf(now);
  const arr = await getMonthPunches(mk);
  const todayIso = isoDate(now);
  const todaysCount = arr.filter(p=> p.employeeId===emp.id && p.ts.slice(0,10)===todayIso).length;
  const type = (todaysCount % 2 === 0) ? 'in' : 'out';
  const punch = { id: uid(), employeeId: emp.id, ts: now.toISOString(), type };
  arr.push(punch);
  await saveMonthPunches(mk, arr);

  state.lastPunchResult = { name: emp.name, type, time: fmtTime(now) };
  render();
  setTimeout(()=>{ state.lastPunchResult=null; state.pinBuffer=''; state.pinLock=false; render(); }, 2600);
}

/* ============================================================
   TAB: PLANNING (emploi du temps)
   ============================================================ */
function renderPlanning(){
  const editRights = canEditPlanning();

  let lockHtml = '';
  if(!editRights){
    lockHtml = `
      <div class="lock-inline">
        <input type="password" id="planningPwInput" placeholder="Code planning ou admin">
        <button class="btn secondary" onclick="tryPlanningLogin()">Modifier le planning</button>
      </div>
      <div id="planningLoginErr" style="color:var(--bad); font-size:.78rem; margin-bottom:10px;"></div>
    `;
  }

  if(state.employees.length === 0){
    return lockHtml + `<div class="empty">Aucun employé enregistré pour le moment.<br>Ajoutez des employés dans l'onglet Admin.</div>`;
  }

  const monday = mondayOf(new Date(state.planningWeek.date + 'T00:00:00'));
  const weekKey = isoDate(monday);
  const weekDates = DAYS.map((d,i)=>{ const dt = new Date(monday); dt.setDate(monday.getDate()+i); return dt; });
  const sunday = weekDates[6];
  const weekLabel = `${monday.toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})} – ${sunday.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'})}`;
  const isCurrentWeek = weekKey === weekKeyForDate(new Date());

  let rows = state.employees.map(emp=>{
    const sched = (state.schedule[weekKey] || {})[emp.id] || {};
    const cells = DAYS.map((d,di)=>{
      const day = sched[d.key];
      let label = 'Repos';
      let cls = 'repos';
      if(day && !day.repos && day.start && day.end){
        const poste = day.posteId ? state.postes.find(p=>p.id===day.posteId) : null;
        const dot = poste ? `<span class="poste-dot" style="background:${poste.color}"></span>` : '';
        label = `${dot}${formatDayRange(day)}${poste ? `<span class="poste-label">${poste.name}</span>` : ''}`;
        cls = '';
      }
      if(cls === 'repos' && IA){
        const ab = IA.absenceFor(emp.id, isoDate(weekDates[di]));
        if(ab){ label = ab; cls = 'repos conge'; }
      }
      const editable = editRights ? 'editable' : '';
      const clickAttr = editRights ? `onclick="openScheduleEditor('${emp.id}','${d.key}','${weekKey}')"` : '';
      return `<td class="cell ${cls} ${editable}" ${clickAttr}>${label}</td>`;
    }).join('');
    const plannedWeekTotal = DAYS.reduce((sum,d)=>{
      const day = sched[d.key];
      if(!day || day.repos) return sum;
      const segs = daySegments(day);
      return sum + segs.reduce((s,seg)=>{
        const [sh,sm] = seg.start.split(':').map(Number);
        const [eh,em] = seg.end.split(':').map(Number);
        return s + ((eh*60+em)-(sh*60+sm))/60;
      }, 0);
    }, 0);
    const hasObjectif = emp.weeklyHours!=null && emp.weeklyHours!=='';
    const objectifStr = hasObjectif ? `${emp.weeklyHours}h` : '—';
    let quotaCls = '';
    let quotaStr = hoursFmt(plannedWeekTotal);
    if(hasObjectif){
      quotaCls = plannedWeekTotal >= Number(emp.weeklyHours) ? 'quota-ok' : 'quota-under';
    }
    return `<tr><td class="name">${emp.name}</td>${cells}<td class="quota-target">${objectifStr}</td><td class="quota-total ${quotaCls}">${quotaStr}</td></tr>`;
  }).join('');

  const legendHtml = state.postes.length ? `
    <div class="poste-legend">
      ${state.postes.map(p=>`<span class="chip"><span class="poste-dot" style="background:${p.color}"></span>${p.name}</span>`).join('')}
    </div>
  ` : '';

  const dupHtml = editRights ? `
    <div class="card" style="margin-bottom:14px;">
      <div class="subtle" style="margin-bottom:8px;">Remplir plusieurs semaines à l'avance :</div>
      <div class="field-row" style="flex-wrap:wrap; gap:10px; align-items:center;">
        <button class="btn secondary" onclick="copyPreviousWeekToCurrent()">⇦ Copier la semaine précédente ici</button>
        <input type="number" id="dupWeeksCount" min="1" max="26" value="4" style="width:64px;">
        <button class="btn secondary" onclick="duplicateWeekForward()">Dupliquer cette semaine sur les X prochaines →</button>
      </div>
      <div id="dupWeeksMsg" class="subtle" style="margin-top:6px;"></div>
    </div>
  ` : '';

  return `
    <h2 class="section-title">Vue du jour</h2>
    ${renderDayView()}
    <div class="divider"></div>
    <h2 class="section-title">Planning hebdomadaire</h2>
    ${lockHtml}
    <div class="day-view-nav">
      <button onclick="shiftPlanningWeek(-1)">◀</button>
      <span class="day-label">Semaine du ${weekLabel}${isCurrentWeek ? ' <span class="subtle" style="font-weight:400;">(en cours)</span>' : ''}</span>
      <button onclick="shiftPlanningWeek(1)">▶</button>
    </div>
    ${!isCurrentWeek ? `<div style="text-align:center; margin-bottom:14px;"><button class="btn secondary" onclick="goToCurrentPlanningWeek()">Revenir à la semaine en cours</button></div>` : ''}
    ${dupHtml}
    ${legendHtml}
    <div class="card scroll-x">
      <table class="sched">
        <thead><tr><th></th>${DAYS.map((d,i)=>`<th>${d.label}<br><span class="subtle" style="font-weight:400;">${weekDates[i].getDate()}/${weekDates[i].getMonth()+1}</span></th>`).join('')}<th>Objectif</th><th>Planifié</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${editRights ? '<div class="subtle">Touchez une case pour modifier les horaires.</div>' : '<div class="subtle">Planning en lecture seule.</div>'}
    <div id="scheduleEditorHost"></div>
  `;
}
function shiftPlanningWeek(deltaWeeks){
  const d = new Date(state.planningWeek.date + 'T00:00:00');
  d.setDate(d.getDate() + deltaWeeks*7);
  state.planningWeek.date = isoDate(d);
  render();
}
function goToCurrentPlanningWeek(){
  state.planningWeek.date = isoDate(new Date());
  render();
}
async function copyPreviousWeekToCurrent(){
  const monday = mondayOf(new Date(state.planningWeek.date + 'T00:00:00'));
  const weekKey = isoDate(monday);
  const prevMonday = new Date(monday); prevMonday.setDate(prevMonday.getDate()-7);
  const prevKey = isoDate(prevMonday);
  const prevSched = state.schedule[prevKey];
  if(!prevSched){
    const msg = document.getElementById('dupWeeksMsg');
    if(msg) msg.textContent = 'Aucun planning trouvé pour la semaine précédente.';
    return;
  }
  state.schedule[weekKey] = JSON.parse(JSON.stringify(prevSched));
  await saveJSON('schedule', state.schedule);
  render();
}
async function duplicateWeekForward(){
  const monday = mondayOf(new Date(state.planningWeek.date + 'T00:00:00'));
  const weekKey = isoDate(monday);
  const srcSched = state.schedule[weekKey];
  const countInput = document.getElementById('dupWeeksCount');
  const count = Math.max(1, Math.min(26, parseInt(countInput ? countInput.value : '4', 10) || 4));
  if(!srcSched){
    const msg = document.getElementById('dupWeeksMsg');
    if(msg) msg.textContent = 'Cette semaine est vide, rien à dupliquer.';
    return;
  }
  for(let i=1; i<=count; i++){
    const target = new Date(monday); target.setDate(target.getDate() + i*7);
    const targetKey = isoDate(target);
    state.schedule[targetKey] = JSON.parse(JSON.stringify(srcSched));
  }
  await saveJSON('schedule', state.schedule);
  const msg = document.getElementById('dupWeeksMsg');
  if(msg) msg.textContent = `Planning dupliqué sur les ${count} semaines suivantes ✓`;
  render();
}
function renderDayView(){
  const d = new Date(state.dayView.date + 'T00:00:00');
  const dayKey = dayKeyForDate(d);
  const label = d.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});

  const slotsHtml = (state.timeSlots.length ? state.timeSlots : []).map(slot=>{
    const people = state.employees.filter(emp=>{
      const day = getScheduleDay(emp.id, state.dayView.date);
      const segs = daySegments(day);
      return segs.some(seg=> seg.start < slot.end && seg.end > slot.start);
    });
    const chips = people.map(p=>{
      const day = getScheduleDay(p.id, state.dayView.date);
      const poste = day && day.posteId ? state.postes.find(x=>x.id===day.posteId) : null;
      const style = poste ? `style="background:${poste.color}22; color:${poste.color}; border-color:${poste.color}55;"` : '';
      return `<span class="person-chip" ${style}>${p.name}</span>`;
    }).join('');
    return `
      <div class="slot-card">
        <div class="slot-head">
          <span class="slot-name">${slot.name}</span>
          <span class="slot-time mono">${slot.start}–${slot.end}</span>
        </div>
        <div class="slot-people">${chips || '<span class="empty-slot">Personne sur ce créneau</span>'}</div>
      </div>
    `;
  }).join('') || `<div class="subtle">Aucun créneau défini. Ajoutez-en dans l'onglet Admin.</div>`;

  return `
    <div class="day-view-nav">
      <button onclick="shiftDayView(-1)">◀</button>
      <span class="day-label">${label}</span>
      <button onclick="shiftDayView(1)">▶</button>
    </div>
    ${slotsHtml}
  `;
}
function shiftDayView(delta){
  const d = new Date(state.dayView.date + 'T00:00:00');
  d.setDate(d.getDate()+delta);
  state.dayView.date = isoDate(d);
  render();
}


function tryPlanningLogin(){
  const val = document.getElementById('planningPwInput').value;
  const okAdmin = state.adminConfig && val === state.adminConfig.password;
  const okPlanning = state.planningConfig && val === state.planningConfig.password;
  if(okAdmin){ state.isAdmin = true; render(); return; }
  if(okPlanning){ state.isPlanningEditor = true; render(); return; }
  document.getElementById('planningLoginErr').textContent = 'Code incorrect.';
}
function lockPlanningEditor(){
  state.isPlanningEditor = false;
  render();
}

function timeQuickSelect(targetId, options){
  const opts = options.map(t=>`<option value="${t}">${t.replace(':','h').replace(/h00$/,'h')}</option>`).join('');
  return `<select class="time-quick" onchange="if(this.value){document.getElementById('${targetId}').value=this.value;} this.selectedIndex=0;">
    <option value="">Suggestions ▾</option>
    ${opts}
  </select>`;
}
function openScheduleEditor(empId, dayKey, weekKey){
  const emp = state.employees.find(e=>e.id===empId);
  weekKey = weekKey || weekKeyForDate(new Date(state.planningWeek.date + 'T00:00:00'));
  const sched = (state.schedule[weekKey] || {})[empId] || {};
  const day = sched[dayKey] || {start:'09:00', end:'17:00', repos:false, posteId:'', breakStart:'', breakEnd:''};
  const posteOptions = `<option value="">Aucun poste</option>` +
    state.postes.map(p=>`<option value="${p.id}" ${day.posteId===p.id?'selected':''}>${p.name}</option>`).join('');
  const hasBreak = !!(day.breakStart && day.breakEnd);
  const host = document.getElementById('scheduleEditorHost');
  host.innerHTML = `
    <div class="card">
      <h2 class="section-title">${emp.name} — ${DAYS.find(d=>d.key===dayKey).label}</h2>
      <div class="field-row">
        <label class="subtle" style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="edRepos" ${day.repos?'checked':''}> Jour de repos
        </label>
      </div>
      <div class="field-row">
        <div class="time-field">
          <span class="subtle time-field-label">Arrivée</span>
          <input type="time" id="edStart" value="${day.start||'09:00'}">
          ${timeQuickSelect('edStart', ['08:00','08:30','09:00'])}
        </div>
        <div class="time-field">
          <span class="subtle time-field-label">Départ</span>
          <input type="time" id="edEnd" value="${day.end||'17:00'}">
          ${timeQuickSelect('edEnd', ['19:00','19:30'])}
        </div>
      </div>
      <div class="field-row">
        <label class="subtle" style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="edHasBreak" ${hasBreak?'checked':''} onchange="document.getElementById('breakFieldsRow').style.display=this.checked?'flex':'none'"> Coupure (ex. pause déjeuner)
        </label>
      </div>
      <div class="field-row" id="breakFieldsRow" style="display:${hasBreak?'flex':'none'};">
        <div class="time-field">
          <span class="subtle time-field-label">Début coupure</span>
          <input type="time" id="edBreakStart" value="${day.breakStart||'12:00'}">
          ${timeQuickSelect('edBreakStart', ['12:00','13:00'])}
        </div>
        <div class="time-field">
          <span class="subtle time-field-label">Fin coupure</span>
          <input type="time" id="edBreakEnd" value="${day.breakEnd||'13:00'}">
          ${timeQuickSelect('edBreakEnd', ['13:00','14:00'])}
        </div>
      </div>
      <div id="schedEditErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
      ${state.postes.length ? `<div class="field-row"><select id="edPoste">${posteOptions}</select></div>` : `<div class="subtle" style="margin-bottom:10px;">Aucun poste défini — ajoutez-en dans Admin pour pouvoir les assigner ici.</div>`}
      <div class="field-row">
        <button class="btn" onclick="saveScheduleDay('${empId}','${dayKey}','${weekKey}')">Enregistrer</button>
        <button class="btn secondary" onclick="document.getElementById('scheduleEditorHost').innerHTML=''">Annuler</button>
      </div>
    </div>
  `;
}
async function saveScheduleDay(empId, dayKey, weekKey){
  const repos = document.getElementById('edRepos').checked;
  const start = document.getElementById('edStart').value;
  const end = document.getElementById('edEnd').value;
  const posteSel = document.getElementById('edPoste');
  const posteId = posteSel ? posteSel.value : '';
  const err = document.getElementById('schedEditErr');
  const hasBreak = document.getElementById('edHasBreak').checked;
  let breakStart = '', breakEnd = '';
  if(!repos && start && end && start >= end){
    err.textContent = 'L\'heure de fin doit être après l\'heure de début.';
    return;
  }
  if(hasBreak){
    breakStart = document.getElementById('edBreakStart').value;
    breakEnd = document.getElementById('edBreakEnd').value;
    if(!breakStart || !breakEnd || breakStart >= breakEnd){
      err.textContent = 'L\'heure de fin de coupure doit être après l\'heure de début de coupure.';
      return;
    }
    if(breakStart < start || breakEnd > end){
      err.textContent = 'La coupure doit être comprise entre l\'heure d\'arrivée et l\'heure de départ.';
      return;
    }
  }
  weekKey = weekKey || weekKeyForDate(new Date(state.planningWeek.date + 'T00:00:00'));
  if(!state.schedule[weekKey]) state.schedule[weekKey] = {};
  if(!state.schedule[weekKey][empId]) state.schedule[weekKey][empId] = {};
  state.schedule[weekKey][empId][dayKey] = { repos, start, end, breakStart, breakEnd, posteId };
  await saveJSON('schedule', state.schedule);
  document.getElementById('scheduleEditorHost').innerHTML = '';
  render();
}

/* ============================================================
   TAB: HEURES
   ============================================================ */
function getWeekRange(ref){
  const d = new Date(ref);
  const day = (d.getDay()+6)%7; // Monday=0
  const monday = new Date(d); monday.setDate(d.getDate()-day);
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  return [monday, sunday];
}
function getMonthRange(ref){
  const d = new Date(ref);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth()+1, 0);
  return [first, last];
}

function renderHeures(){
  if(state.employees.length === 0){
    return `<div class="empty">Aucun employé enregistré pour le moment.</div>`;
  }

  if(!state.isAdmin){
    return renderHeuresSelfService();
  }

  const empOptions = `<option value="tous">Tous les employés</option>` +
    state.employees.map(e=>`<option value="${e.id}" ${state.heures.scope===e.id?'selected':''}>${e.name}</option>`).join('');

  return `
    <h2 class="section-title">Heures travaillées</h2>
    <div class="filters">
      <select id="hEmp">${empOptions}</select>
      <div class="seg" id="hPeriodSeg">
        <button data-p="week" class="${state.heures.period==='week'?'active':''}">Cette semaine</button>
        <button data-p="month" class="${state.heures.period==='month'?'active':''}">Ce mois</button>
        <button data-p="custom" class="${state.heures.period==='custom'?'active':''}">Personnalisé</button>
      </div>
    </div>
    <div class="filters" id="customDates" style="${state.heures.period==='custom'?'':'display:none'}">
      <input type="date" id="hStart" value="${state.heures.customStart||''}">
      <input type="date" id="hEnd" value="${state.heures.customEnd||''}">
    </div>
    <div class="filters">
      <button class="btn" id="hCalc">Calculer</button>
      <button class="btn secondary" id="hExport">Exporter en Excel</button>
    </div>
    <div id="hResults"><div class="subtle">Choisissez une période puis « Calculer ».</div></div>
  `;
}

function attachHeuresHandlers(){
  const seg = document.getElementById('hPeriodSeg');
  if(seg){
    seg.querySelectorAll('button').forEach(b=>{
      b.addEventListener('click', ()=>{
        state.heures.period = b.dataset.p;
        render();
      });
    });
  }
  const empSel = document.getElementById('hEmp');
  if(empSel) empSel.addEventListener('change', e=> state.heures.scope = e.target.value);
  const calcBtn = document.getElementById('hCalc');
  if(calcBtn) calcBtn.addEventListener('click', calcHeures);
  const expBtn = document.getElementById('hExport');
  if(expBtn) expBtn.addEventListener('click', exportHeures);
}

function renderHeuresSelfService(){
  if(!state.heuresSelf.unlockedEmployeeId){
    let dotsHtml = '';
    for(let i=0;i<4;i++){
      dotsHtml += `<div class="dot ${i < state.heuresSelf.codeBuffer.length ? 'filled':''}"></div>`;
    }
    const grid = ['1','2','3','4','5','6','7','8','9','fn_clear','0','fn_back'];
    const gridHtml = grid.map(k=>{
      if(k==='fn_clear') return `<button class="fn" onclick="hsClear()">Effacer</button>`;
      if(k==='fn_back') return `<button class="fn" onclick="hsBackspace()">⌫</button>`;
      return `<button onclick="hsPress('${k}')">${k}</button>`;
    }).join('');
    return `
      <h2 class="section-title">Mes heures</h2>
      <div class="punch-wrap">
        <div class="card-perf">
          <div class="pin-dots ${state.heuresSelf.error?'shake':''}">${dotsHtml}</div>
          <div class="subtle">Entrez votre code personnel pour voir vos heures</div>
          ${state.heuresSelf.error ? `<div style="color:var(--bad); font-size:.78rem; margin-top:8px;">${state.heuresSelf.error}</div>` : ''}
        </div>
        <div class="keypad">${gridHtml}</div>
      </div>
    `;
  }

  const emp = state.employees.find(e=>e.id===state.heuresSelf.unlockedEmployeeId);
  if(!emp){ state.heuresSelf.unlockedEmployeeId = null; return renderHeuresSelfService(); }

  return `
    <h2 class="section-title">Mes heures — ${emp.name}</h2>
    <div class="filters">
      <div class="seg" id="hsPeriodSeg">
        <button data-p="week" class="${state.heures.period==='week'?'active':''}">Cette semaine</button>
        <button data-p="month" class="${state.heures.period==='month'?'active':''}">Ce mois</button>
      </div>
      <button class="btn secondary" onclick="hsLogout()">Changer de personne</button>
    </div>
    <div id="hResults"><div class="subtle">Chargement…</div></div>
  `;
}
function hsPress(d){
  if(state.heuresSelf.codeBuffer.length>=4) return;
  state.heuresSelf.codeBuffer += d;
  state.heuresSelf.error = '';
  if(state.heuresSelf.codeBuffer.length===4){
    const emp = state.employees.find(e=>e.code===state.heuresSelf.codeBuffer);
    if(emp){
      state.heuresSelf.unlockedEmployeeId = emp.id;
      state.heuresSelf.codeBuffer = '';
      render();
      calcSelfHeures();
      return;
    } else {
      state.heuresSelf.error = 'Code inconnu';
      render();
      setTimeout(()=>{ state.heuresSelf.codeBuffer=''; state.heuresSelf.error=''; render(); }, 1400);
      return;
    }
  }
  render();
}
function hsBackspace(){ state.heuresSelf.codeBuffer = state.heuresSelf.codeBuffer.slice(0,-1); render(); }
function hsClear(){ state.heuresSelf.codeBuffer=''; render(); }
function hsLogout(){ state.heuresSelf.unlockedEmployeeId=null; render(); }

async function calcSelfHeures(){
  const seg = document.getElementById('hsPeriodSeg');
  if(seg){
    seg.querySelectorAll('button').forEach(b=>{
      b.addEventListener('click', ()=>{ state.heures.period = b.dataset.p; calcSelfHeures(); });
    });
  }
  const [start,end] = state.heures.period==='month' ? getMonthRange(new Date()) : getWeekRange(new Date());
  const punches = await fetchPunchesInRange(start,end);
  const res = computeEmployeeHours(punches, state.heuresSelf.unlockedEmployeeId);
  const empRef = state.employees.find(e=>e.id===state.heuresSelf.unlockedEmployeeId);
  const rows = res.days.map(d=>{
    const intervalsStr = d.intervals.map(iv=> iv.end ? `${iv.start}–${iv.end}` : `${iv.start}–?`).join(', ') || '—';
    const supTag = (!d.incomplete && d.overtime > (1/60)) ? `<span class="sup-tag">+${hoursFmt(d.overtime)} sup</span>` : '';
    return `<tr class="${d.incomplete?'incomplete':''}">
      <td>${fmtDate(new Date(d.date+'T00:00:00'))}</td>
      <td>${intervalsStr}${d.incomplete?'<span class="warn-tag">Incomplet</span>':''}${supTag}</td>
      <td class="total">${d.incomplete ? '—' : hoursFmt(d.normal)}</td>
      <td class="overtime">${d.incomplete ? '—' : hoursFmt(d.overtime)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="subtle" style="padding:14px 0;">Aucun pointage sur cette période.</td></tr>`;

  const host = document.getElementById('hResults');
  if(!host) return;
  const contractHtml = empRef && empRef.weeklyHours!=null && empRef.weeklyHours!=='' ? ` <span class="contract">(contrat : ${empRef.weeklyHours}h/semaine)</span>` : '';
  host.innerHTML = `
    <div class="subtle" style="margin-bottom:12px;">Période : ${fmtDate(start)} → ${fmtDate(end)}</div>
    <div class="emp-block">
      <h3>Total <span class="total mono">${hoursFmt(res.grandTotal)}</span>${contractHtml}</h3>
      <div class="subtle" style="margin-bottom:10px;">Dont heures normales : <b class="mono">${hoursFmt(res.grandNormal)}</b> · heures sup : <b class="mono" style="color:var(--brass);">${hoursFmt(res.grandOvertime)}</b></div>
      <table class="hours">
        <thead><tr><th>Date</th><th>Intervalles</th><th>Normales</th><th>Sup</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function getRangeForCurrentFilter(){
  let start, end;
  if(state.heures.period==='week'){ [start,end] = getWeekRange(new Date()); }
  else if(state.heures.period==='month'){ [start,end] = getMonthRange(new Date()); }
  else {
    const s = document.getElementById('hStart').value;
    const e = document.getElementById('hEnd').value;
    if(!s || !e){ return null; }
    start = new Date(s+'T00:00:00'); end = new Date(e+'T00:00:00');
  }
  return [start,end];
}

async function fetchPunchesInRange(start, end){
  const months = new Set();
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while(cur <= last){
    months.add(monthKeyOf(cur));
    cur.setMonth(cur.getMonth()+1);
  }
  let all = [];
  for(const mk of months){
    const arr = await getMonthPunches(mk);
    all = all.concat(arr);
  }
  const startIso = isoDate(start), endIso = isoDate(end);
  return all.filter(p=>{
    const d = p.ts.slice(0,10);
    return d >= startIso && d <= endIso;
  });
}

/* Heures prévues au planning pour un employé, à une date donnée (tient compte de la coupure) */
function scheduledHoursForDate(empId, dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  const dayKey = dayKeyForDate(d);
  const day = getScheduleDay(empId, dateStr);
  if(!day || day.repos) return 0;
  const segs = daySegments(day);
  let total = 0;
  segs.forEach(s=>{
    const [sh,sm] = s.start.split(':').map(Number);
    const [eh,em] = s.end.split(':').map(Number);
    total += ((eh*60+em) - (sh*60+sm)) / 60;
  });
  return total;
}

function computeEmployeeHours(punches, empId){
  const mine = punches.filter(p=> p.employeeId===empId).sort((a,b)=> a.ts.localeCompare(b.ts));
  const byDay = {};
  mine.forEach(p=>{
    const d = p.ts.slice(0,10);
    if(!byDay[d]) byDay[d] = [];
    byDay[d].push(p);
  });
  const days = Object.keys(byDay).sort().map(d=>{
    const list = byDay[d].sort((a,b)=>a.ts.localeCompare(b.ts));
    const intervals = [];
    let total = 0;
    let incomplete = false;
    for(let i=0;i<list.length;i+=2){
      const inP = list[i], outP = list[i+1];
      if(outP){
        const h = (new Date(outP.ts) - new Date(inP.ts)) / 3600000;
        total += h;
        intervals.push({start: fmtTime(new Date(inP.ts)), end: fmtTime(new Date(outP.ts)), h});
      } else {
        incomplete = true;
        intervals.push({start: fmtTime(new Date(inP.ts)), end: null, h:null});
      }
    }
    const planned = scheduledHoursForDate(empId, d);
    let normal = null, overtime = null;
    if(!incomplete){
      normal = Math.min(total, planned);
      overtime = Math.max(0, total - planned);
    }
    return { date: d, intervals, total, incomplete, planned, normal, overtime };
  });
  const grandTotal = days.reduce((s,d)=> s + d.total, 0);
  const grandNormal = days.reduce((s,d)=> s + (d.normal||0), 0);
  const grandOvertime = days.reduce((s,d)=> s + (d.overtime||0), 0);
  return { days, grandTotal, grandNormal, grandOvertime };
}

let lastHeuresCompute = null;

async function calcHeures(){
  const range = await getRangeForCurrentFilter();
  if(state.heures.period==='custom'){
    state.heures.customStart = document.getElementById('hStart').value;
    state.heures.customEnd = document.getElementById('hEnd').value;
  }
  const host = document.getElementById('hResults');
  if(!range){ host.innerHTML = '<div class="subtle">Sélectionnez une date de début et de fin.</div>'; return; }
  const [start,end] = range;
  const punches = await fetchPunchesInRange(start,end);
  const scope = document.getElementById('hEmp').value;
  const targets = scope==='tous' ? state.employees : state.employees.filter(e=>e.id===scope);

  if(targets.length===0){ host.innerHTML = '<div class="empty">Aucun employé.</div>'; return; }

  let html = `<div class="subtle" style="margin-bottom:12px;">Période : ${fmtDate(start)} → ${fmtDate(end)}</div>`;
  const results = {};
  targets.forEach(emp=>{
    const res = computeEmployeeHours(punches, emp.id);
    results[emp.id] = res;
    const rows = res.days.map(d=>{
      const intervalsStr = d.intervals.map(iv=> iv.end ? `${iv.start}–${iv.end}` : `${iv.start}–?`).join(', ') || '—';
      const supTag = (!d.incomplete && d.overtime > (1/60)) ? `<span class="sup-tag">+${hoursFmt(d.overtime)} sup</span>` : '';
      return `<tr class="${d.incomplete?'incomplete':''}">
        <td>${fmtDate(new Date(d.date+'T00:00:00'))}</td>
        <td>${intervalsStr}${d.incomplete?'<span class="warn-tag">Incomplet</span>':''}${supTag}</td>
        <td class="total">${d.incomplete ? '—' : hoursFmt(d.normal)}</td>
        <td class="overtime">${d.incomplete ? '—' : hoursFmt(d.overtime)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" class="subtle" style="padding:14px 0;">Aucun pointage sur cette période.</td></tr>`;
    const contractHtml = emp.weeklyHours!=null && emp.weeklyHours!=='' ? ` <span class="contract">(contrat : ${emp.weeklyHours}h/semaine)</span>` : '';
    html += `
      <div class="emp-block">
        <h3>${emp.name} <span class="total mono">${hoursFmt(res.grandTotal)}</span>${contractHtml}</h3>
        <div class="subtle" style="margin-bottom:10px;">Dont heures normales : <b class="mono">${hoursFmt(res.grandNormal)}</b> · heures sup : <b class="mono" style="color:var(--brass);">${hoursFmt(res.grandOvertime)}</b></div>
        <table class="hours">
          <thead><tr><th>Date</th><th>Intervalles</th><th>Normales</th><th>Sup</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  });
  host.innerHTML = html;
  lastHeuresCompute = { start, end, results, targets };
}

async function exportHeures(){
  if(!lastHeuresCompute){ await calcHeures(); }
  if(!lastHeuresCompute) return;
  const { start, end, results, targets } = lastHeuresCompute;
  const wb = XLSX.utils.book_new();
  targets.forEach(emp=>{
    const res = results[emp.id];
    const aoa = [['Date','Entrée 1','Sortie 1','Entrée 2','Sortie 2','Entrée 3','Sortie 3','Heures normales (h)','Heures sup (h)','Total (h)']];
    res.days.forEach(d=>{
      const row = [ new Date(d.date+'T00:00:00').toLocaleDateString('fr-FR') ];
      for(let i=0;i<3;i++){
        const iv = d.intervals[i];
        row.push(iv ? iv.start : '');
        row.push(iv && iv.end ? iv.end : (iv ? '(manquant)' : ''));
      }
      row.push(d.incomplete ? '' : Number(d.normal.toFixed(2)));
      row.push(d.incomplete ? '' : Number(d.overtime.toFixed(2)));
      row.push(Number(d.total.toFixed(2)));
      aoa.push(row);
    });
    aoa.push([]);
    aoa.push(['','','','','','','TOTAL', Number(res.grandNormal.toFixed(2)), Number(res.grandOvertime.toFixed(2)), Number(res.grandTotal.toFixed(2))]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{wch:12},{wch:9},{wch:9},{wch:9},{wch:9},{wch:9},{wch:9},{wch:14},{wch:12},{wch:10}];
    XLSX.utils.book_append_sheet(wb, ws, emp.name.substring(0,31) || 'Employé');
  });
  const fname = `Heures_${isoDate(start)}_au_${isoDate(end)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

/* ============================================================
   TAB: ADMIN
   ============================================================ */
function renderAdmin(){
  if(!state.isAdmin){
    if(!state.adminConfig){
      return `
        <div class="lock-screen">
          <h2 class="section-title">Première configuration</h2>
          <div class="card">
            <p class="subtle">Choisissez un code Admin (accès complet) et un code Planning (permet uniquement de modifier les horaires, sans accès aux employés ni aux réglages).</p>
            <input type="password" id="newAdminPw" placeholder="Code admin">
            <input type="password" id="newAdminPw2" placeholder="Confirmer le code admin">
            <input type="password" id="newPlanningPw" placeholder="Code planning (optionnel, modifiable plus tard)">
            <div id="adminSetupErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
            <button class="btn" onclick="setupAdminPassword()">Enregistrer</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="lock-screen">
        <h2 class="section-title">Accès administrateur</h2>
        <div class="card">
          <input type="password" id="adminPwInput" placeholder="Mot de passe">
          <div id="adminLoginErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
          <button class="btn" onclick="tryAdminLogin()">Déverrouiller</button>
        </div>
      </div>
    `;
  }

  const empListHtml = state.employees.map(e=>`
    <li>
      <div class="info"><b>${e.name}</b><span>Code : ${e.code}${e.weeklyHours!=null && e.weeklyHours!=='' ? ' · ' + e.weeklyHours + 'h/semaine' : ''}</span></div>
      <div class="actions">
        <button onclick="editEmployee('${e.id}')">Modifier</button>
        <button onclick="deleteEmployee('${e.id}')">Supprimer</button>
      </div>
    </li>
  `).join('') || `<li class="subtle" style="border:none;">Aucun employé pour l'instant.</li>`;

  return `
    <h2 class="section-title">Employés</h2>
    <div class="card">
      <ul class="emp-list">${empListHtml}</ul>
      <div class="divider"></div>
      <div id="empFormHost"></div>
      <button class="btn" onclick="openEmployeeForm()">+ Ajouter un employé</button>
    </div>

    <h2 class="section-title">Corriger un pointage</h2>
    <div class="card">
      <div class="field-row">
        <select id="corrEmp">
          <option value="">Choisir un employé</option>
          ${state.employees.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}
        </select>
        <input type="date" id="corrDate">
        <button class="btn secondary" onclick="loadCorrection()">Afficher</button>
      </div>
      <div id="corrHost"></div>
    </div>

    <h2 class="section-title">Postes</h2>
    <div class="card">
      <p class="subtle" style="margin-bottom:12px;">Définissez les postes (ex : Caisse, Cuisine, Accueil...) avec une couleur. Vous pourrez ensuite assigner un poste à chaque personne, jour par jour, dans le planning.</p>
      ${state.postes.map(p=>`
        <div class="poste-admin-row">
          <span class="poste-dot" style="background:${p.color}"></span>
          <span class="pa-name">${p.name}</span>
          <button class="btn secondary" onclick="editPoste('${p.id}')" style="padding:5px 10px; font-size:.72rem;">Modifier</button>
          <button class="btn danger" onclick="deletePoste('${p.id}')" style="padding:5px 10px; font-size:.72rem;">Suppr.</button>
        </div>
      `).join('') || `<div class="subtle">Aucun poste défini.</div>`}
      <div class="divider"></div>
      <div id="posteFormHost"></div>
      <button class="btn" onclick="openPosteForm()">+ Ajouter un poste</button>
    </div>

    <h2 class="section-title">Créneaux horaires (vue du jour)</h2>
    <div class="card">
      <p class="subtle" style="margin-bottom:12px;">Définissez vos créneaux (ex : Matin, Midi, Après-midi...). La vue du jour dans l'onglet Planning affiche automatiquement qui travaille sur chaque créneau, à partir des horaires du planning.</p>
      ${state.timeSlots.map(s=>`
        <div class="slot-admin-row">
          <span class="sa-name">${s.name}</span>
          <span class="sa-time">${s.start}–${s.end}</span>
          <button class="btn secondary" onclick="editTimeSlot('${s.id}')" style="padding:5px 10px; font-size:.72rem;">Modifier</button>
          <button class="btn danger" onclick="deleteTimeSlot('${s.id}')" style="padding:5px 10px; font-size:.72rem;">Suppr.</button>
        </div>
      `).join('') || `<div class="subtle">Aucun créneau défini.</div>`}
      <div class="divider"></div>
      <div id="slotFormHost"></div>
      <button class="btn" onclick="openTimeSlotForm()">+ Ajouter un créneau</button>
    </div>

    <h2 class="section-title">Sécurité</h2>
    <div class="card">
      <div class="subtle" style="margin-bottom:10px;">Code admin (accès complet)</div>
      <div class="field-row">
        <input type="password" id="pwOld" placeholder="Code admin actuel">
        <input type="password" id="pwNew" placeholder="Nouveau code admin">
      </div>
      <div id="pwChangeErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
      <button class="btn secondary" onclick="changeAdminPassword()">Changer le code admin</button>
      <div class="divider"></div>
      <div class="subtle" style="margin-bottom:10px;">Code planning (modification des horaires uniquement)</div>
      <div class="field-row">
        <input type="password" id="planningPwNew" placeholder="Nouveau code planning">
      </div>
      <div id="planningPwErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
      <button class="btn secondary" onclick="changePlanningPassword()">Changer le code planning</button>
    </div>

    <h2 class="section-title">Lien de consultation à distance</h2>
    <div class="card">
      <p class="subtle">Ce lien n'affiche que le Planning, les Heures (par code personnel) et l'Admin — sans l'onglet Pointage. À partager avec l'équipe pour un accès depuis leur téléphone.</p>
      <div class="field-row">
        <input type="text" id="consultLink" readonly value="${location.href.split('?')[0]}?mode=consultation" style="flex:1; min-width:200px;">
        <button class="btn secondary" onclick="copyConsultLink()">Copier</button>
      </div>
      <div id="copyMsg" style="font-size:.75rem; color: var(--good);"></div>
    </div>

    ${IA ? IA.renderAdminIA() : ''}
  `;
}
async function changePlanningPassword(){
  const newPw = document.getElementById('planningPwNew').value;
  const err = document.getElementById('planningPwErr');
  if(!newPw || newPw.length < 4){ err.textContent = 'Le code doit contenir au moins 4 caractères.'; return; }
  state.planningConfig = { password: newPw };
  await saveJSON('planning_config', state.planningConfig);
  err.style.color = 'var(--good)';
  err.textContent = 'Code planning mis à jour.';
}
function copyConsultLink(){
  const input = document.getElementById('consultLink');
  input.select();
  navigator.clipboard.writeText(input.value).then(()=>{
    document.getElementById('copyMsg').textContent = 'Lien copié !';
    setTimeout(()=>{ const m=document.getElementById('copyMsg'); if(m) m.textContent=''; }, 2000);
  }).catch(()=>{
    document.getElementById('copyMsg').textContent = 'Sélectionnez et copiez le lien manuellement.';
  });
}

/* ---- time slots (vue du jour) ---- */
function openTimeSlotForm(existing){
  const host = document.getElementById('slotFormHost');
  const slot = existing || {name:'', start:'08:00', end:'12:00'};
  host.innerHTML = `
    <div class="field-row">
      <input type="text" id="slotName" placeholder="Nom du créneau" value="${slot.name}">
      <input type="time" id="slotStart" value="${slot.start}">
      <input type="time" id="slotEnd" value="${slot.end}">
    </div>
    <div id="slotFormErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
    <div class="field-row">
      <button class="btn" onclick="saveTimeSlot('${existing?existing.id:''}')">${existing?'Enregistrer':'Ajouter'}</button>
      <button class="btn secondary" onclick="document.getElementById('slotFormHost').innerHTML=''">Annuler</button>
    </div>
  `;
}
function editTimeSlot(id){
  const slot = state.timeSlots.find(s=>s.id===id);
  openTimeSlotForm(slot);
}
async function saveTimeSlot(existingId){
  const name = document.getElementById('slotName').value.trim();
  const start = document.getElementById('slotStart').value;
  const end = document.getElementById('slotEnd').value;
  const err = document.getElementById('slotFormErr');
  if(!name){ err.textContent = 'Le nom est requis.'; return; }
  if(!start || !end || start >= end){ err.textContent = 'L\'heure de fin doit être après l\'heure de début.'; return; }
  if(existingId){
    const slot = state.timeSlots.find(s=>s.id===existingId);
    slot.name = name; slot.start = start; slot.end = end;
  } else {
    state.timeSlots.push({ id: uid(), name, start, end });
  }
  await saveJSON('time_slots', state.timeSlots);
  document.getElementById('slotFormHost').innerHTML = '';
  render();
}
async function deleteTimeSlot(id){
  if(!confirm('Supprimer ce créneau ?')) return;
  state.timeSlots = state.timeSlots.filter(s=>s.id!==id);
  await saveJSON('time_slots', state.timeSlots);
  render();
}

/* ---- postes ---- */
const POSTE_COLORS = ['#e3a44d','#4fb0a5','#5fbe8a','#e0654f','#8b93a1','#6c8ff0','#c77dff','#f2a65a'];
function openPosteForm(existing){
  const host = document.getElementById('posteFormHost');
  const poste = existing || {name:'', color: POSTE_COLORS[state.postes.length % POSTE_COLORS.length]};
  host.innerHTML = `
    <div class="field-row">
      <input type="text" id="posteName" placeholder="Nom du poste" value="${poste.name}">
      <input type="color" id="posteColor" value="${poste.color}" style="width:50px; padding:2px; height:38px; border:1px solid var(--border); border-radius:8px; background:transparent;">
    </div>
    <div id="posteFormErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
    <div class="field-row">
      <button class="btn" onclick="savePoste('${existing?existing.id:''}')">${existing?'Enregistrer':'Ajouter'}</button>
      <button class="btn secondary" onclick="document.getElementById('posteFormHost').innerHTML=''">Annuler</button>
    </div>
  `;
}
function editPoste(id){
  const poste = state.postes.find(p=>p.id===id);
  openPosteForm(poste);
}
async function savePoste(existingId){
  const name = document.getElementById('posteName').value.trim();
  const color = document.getElementById('posteColor').value;
  const err = document.getElementById('posteFormErr');
  if(!name){ err.textContent = 'Le nom est requis.'; return; }
  if(existingId){
    const poste = state.postes.find(p=>p.id===existingId);
    poste.name = name; poste.color = color;
  } else {
    state.postes.push({ id: uid(), name, color });
  }
  await saveJSON('postes', state.postes);
  document.getElementById('posteFormHost').innerHTML = '';
  render();
}
async function deletePoste(id){
  if(!confirm('Supprimer ce poste ? Il sera retiré des jours où il était assigné.')) return;
  state.postes = state.postes.filter(p=>p.id!==id);
  await saveJSON('postes', state.postes);
  render();
}

async function setupAdminPassword(){
  const p1 = document.getElementById('newAdminPw').value;
  const p2 = document.getElementById('newAdminPw2').value;
  const p3 = document.getElementById('newPlanningPw').value;
  const err = document.getElementById('adminSetupErr');
  if(!p1 || p1.length < 4){ err.textContent = 'Le code admin doit contenir au moins 4 caractères.'; return; }
  if(p1 !== p2){ err.textContent = 'Les codes admin ne correspondent pas.'; return; }
  if(p3 && p3.length < 4){ err.textContent = 'Le code planning doit contenir au moins 4 caractères.'; return; }
  state.adminConfig = { password: p1 };
  await saveJSON('admin_config', state.adminConfig);
  if(p3){
    state.planningConfig = { password: p3 };
    await saveJSON('planning_config', state.planningConfig);
  }
  state.isAdmin = true;
  render();
}
function tryAdminLogin(){
  const val = document.getElementById('adminPwInput').value;
  if(val === state.adminConfig.password){
    state.isAdmin = true;
    render();
  } else {
    document.getElementById('adminLoginErr').textContent = 'Mot de passe incorrect.';
  }
}
function lockAdmin(){
  state.isAdmin = false;
  render();
}
async function changeAdminPassword(){
  const oldPw = document.getElementById('pwOld').value;
  const newPw = document.getElementById('pwNew').value;
  const err = document.getElementById('pwChangeErr');
  if(oldPw !== state.adminConfig.password){ err.textContent = 'Mot de passe actuel incorrect.'; return; }
  if(!newPw || newPw.length < 4){ err.textContent = 'Le nouveau mot de passe doit contenir au moins 4 caractères.'; return; }
  state.adminConfig.password = newPw;
  await saveJSON('admin_config', state.adminConfig);
  err.style.color = 'var(--good)';
  err.textContent = 'Mot de passe mis à jour.';
}

/* ---- employee management ---- */
function openEmployeeForm(existing){
  const host = document.getElementById('empFormHost');
  const emp = existing || {name:'', code:'', weeklyHours:''};
  host.innerHTML = `
    <div class="field-row">
      <input type="text" id="empName" placeholder="Nom complet" value="${emp.name}">
      <input type="text" id="empCode" placeholder="Code à 4 chiffres" maxlength="4" value="${emp.code}">
      <button class="btn secondary" onclick="suggestCode()">Générer</button>
    </div>
    <div class="field-row">
      <input type="text" inputmode="decimal" id="empWeeklyHours" placeholder="Heures / semaine (ex: 35)" value="${emp.weeklyHours!=null && emp.weeklyHours!=='' ? emp.weeklyHours : ''}">
    </div>
    <div id="empFormErr" style="color:var(--bad); font-size:.78rem; margin-bottom:8px;"></div>
    <div class="field-row">
      <button class="btn" onclick="saveEmployee('${existing?existing.id:''}')">${existing?'Enregistrer':'Ajouter'}</button>
      <button class="btn secondary" onclick="document.getElementById('empFormHost').innerHTML=''">Annuler</button>
    </div>
  `;
}
function suggestCode(){
  let code;
  do{ code = String(Math.floor(1000 + Math.random()*9000)); }
  while(state.employees.some(e=>e.code===code));
  document.getElementById('empCode').value = code;
}
function editEmployee(id){
  const emp = state.employees.find(e=>e.id===id);
  openEmployeeForm(emp);
}
async function saveEmployee(existingId){
  const name = document.getElementById('empName').value.trim();
  const code = document.getElementById('empCode').value.trim();
  const weeklyHoursRaw = document.getElementById('empWeeklyHours').value.trim().replace(',', '.');
  const err = document.getElementById('empFormErr');
  if(!name){ err.textContent = 'Le nom est requis.'; return; }
  if(!/^\d{4}$/.test(code)){ err.textContent = 'Le code doit contenir exactement 4 chiffres.'; return; }
  const conflict = state.employees.find(e=> e.code===code && e.id!==existingId);
  if(conflict){ err.textContent = 'Ce code est déjà utilisé par ' + conflict.name + '.'; return; }
  let weeklyHours = null;
  if(weeklyHoursRaw !== ''){
    weeklyHours = Number(weeklyHoursRaw);
    if(isNaN(weeklyHours) || weeklyHours < 0){ err.textContent = 'Les heures / semaine doivent être un nombre valide.'; return; }
  }

  if(existingId){
    const emp = state.employees.find(e=>e.id===existingId);
    emp.name = name; emp.code = code; emp.weeklyHours = weeklyHours;
  } else {
    state.employees.push({ id: uid(), name, code, weeklyHours });
  }
  await saveJSON('employees', state.employees);
  document.getElementById('empFormHost').innerHTML = '';
  render();
}
async function deleteEmployee(id){
  if(!confirm('Supprimer cet employé ? Son historique de pointage sera conservé mais ne sera plus visible facilement.')) return;
  state.employees = state.employees.filter(e=>e.id!==id);
  await saveJSON('employees', state.employees);
  Object.keys(state.schedule).forEach(wk=>{ if(state.schedule[wk]) delete state.schedule[wk][id]; });
  await saveJSON('schedule', state.schedule);
  render();
}

/* ---- correction ---- */
async function loadCorrection(){
  const empId = document.getElementById('corrEmp').value;
  const date = document.getElementById('corrDate').value;
  const host = document.getElementById('corrHost');
  if(!empId || !date){ host.innerHTML = '<div class="subtle">Choisissez un employé et une date.</div>'; return; }
  const mk = monthKeyOf(new Date(date+'T00:00:00'));
  const arr = await getMonthPunches(mk);
  state.correction = { employeeId: empId, date, monthKey: mk };
  renderCorrection(arr);
}
function renderCorrection(monthArr){
  const { employeeId, date } = state.correction;
  const dayPunches = monthArr
    .map((p, idx)=> ({...p, idx}))
    .filter(p=> p.employeeId===employeeId && p.ts.slice(0,10)===date)
    .sort((a,b)=> a.ts.localeCompare(b.ts));
  const rows = dayPunches.map((p, i)=>{
    const t = new Date(p.ts);
    const timeStr = t.toTimeString().slice(0,5);
    return `<div class="field-row" style="align-items:center;">
      <span class="subtle" style="min-width:60px;">${p.type==='in'?'Entrée':'Sortie'}</span>
      <input type="time" value="${timeStr}" onchange="updateCorrectionTime(${p.idx}, this.value)">
      <button class="btn danger" onclick="deleteCorrectionPunch(${p.idx})">Supprimer</button>
    </div>`;
  }).join('') || `<div class="subtle">Aucun pointage ce jour-là.</div>`;

  const host = document.getElementById('corrHost');
  host.innerHTML = `
    <div class="divider"></div>
    ${rows}
    <div class="field-row" style="margin-top:10px;">
      <select id="addPunchType"><option value="in">Entrée</option><option value="out">Sortie</option></select>
      <input type="time" id="addPunchTime" value="09:00">
      <button class="btn secondary" onclick="addCorrectionPunch()">Ajouter un pointage</button>
    </div>
  `;
}
async function updateCorrectionTime(idx, timeVal){
  const { monthKey, date } = state.correction;
  const arr = await getMonthPunches(monthKey);
  const [hh,mm] = timeVal.split(':');
  const d = new Date(date+'T00:00:00');
  d.setHours(Number(hh), Number(mm), 0, 0);
  arr[idx].ts = d.toISOString();
  await saveMonthPunches(monthKey, arr);
  renderCorrection(arr);
}
async function deleteCorrectionPunch(idx){
  const { monthKey } = state.correction;
  const arr = await getMonthPunches(monthKey);
  arr.splice(idx,1);
  await saveMonthPunches(monthKey, arr);
  renderCorrection(arr);
}
async function addCorrectionPunch(){
  const { employeeId, date, monthKey } = state.correction;
  const type = document.getElementById('addPunchType').value;
  const timeVal = document.getElementById('addPunchTime').value;
  const [hh,mm] = timeVal.split(':');
  const d = new Date(date+'T00:00:00');
  d.setHours(Number(hh), Number(mm), 0, 0);
  const arr = await getMonthPunches(monthKey);
  arr.push({ id: uid(), employeeId, ts: d.toISOString(), type });
  await saveMonthPunches(monthKey, arr);
  renderCorrection(arr);
}

/* Expose functions used by inline onclick="" handlers in the HTML,
   required because <script type="module"> no longer puts them in global scope. */
Object.assign(window, {
  addCorrectionPunch, changeAdminPassword, changePlanningPassword, copyConsultLink,
  deleteCorrectionPunch, deleteEmployee, deletePoste, deleteTimeSlot,
  editEmployee, editPoste, editTimeSlot, hsBackspace, hsClear, hsLogout, hsPress,
  loadCorrection, lockAdmin, lockPlanningEditor, openEmployeeForm, openPosteForm,
  openScheduleEditor, openTimeSlotForm, pinBackspace, pinClear, pinPress,
  saveEmployee, savePoste, saveScheduleDay, saveTimeSlot, setupAdminPassword,
  shiftDayView, suggestCode, tryAdminLogin, tryPlanningLogin,
  shiftPlanningWeek, goToCurrentPlanningWeek, copyPreviousWeekToCurrent, duplicateWeekForward
});

init();
