/* ============================================================
   Kortes Trip 2026 — Gedeelde checklist-sync (naam-picker, geen Auth)
   ============================================================
   Vereenvoudigd: geen e-mail/login meer nodig. Je kiest één keer
   je naam, die wordt permanent onthouden op dit apparaat. Er staat
   geen gevoelige data in deze tabellen (alleen checklist/beslissing-
   status), dus we gebruiken de publieke anon-key rechtstreeks.
   ============================================================ */

const SUPABASE_URL = 'https://lyldstmxhyqgwsrhkxxj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5bGRzdG14aHlxZ3dzcmhreHhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NzYwMDAsImV4cCI6MjA5OTI1MjAwMH0.ggBQ1B84eVqOxXDmc1slwZTNjoFrjAtYSZfA2mNuffw';
const WORKSPACE_SLUG = 'kortes-2026';
const FAMILY_NAMES = ['Henk Jan', 'Jersica', 'Oscar', 'Lucas'];
const NAME_KEY = 'kortes-trip-2026-family-name';

const SYNC_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabaseClient = null;
let currentWorkspaceId = null;
let checklistRealtimeChannel = null;
let decisionRealtimeChannel = null;

let SHARED_STATE = {};
let SHARED_DECISION_STATE = {};

const CHECKLIST_PENDING_KEY = 'kortes-trip-2026-pending-sync';
const DECISION_PENDING_KEY = 'kortes-trip-2026-pending-decision-sync';

// ============================================================
// INIT
// ============================================================
async function initSync(){
  if(!SYNC_ENABLED){
    setSyncBadge('local');
    return;
  }
  if(typeof window.supabase === 'undefined'){
    await loadSupabaseLib();
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data: ws, error } = await supabaseClient
    .from('trip_workspaces').select('id').eq('slug', WORKSPACE_SLUG).single();
  if(error || !ws){
    console.warn('[sync] workspace niet gevonden', error);
    setSyncBadge('local');
    return;
  }
  currentWorkspaceId = ws.id;

  if(getFamilyName()){
    await afterNamePicked();
  } else {
    setSyncBadge('signed-out');
  }

  window.addEventListener('online', () => { flushChecklistPending(); flushDecisionPending(); });
  window.addEventListener('offline', () => setSyncBadge('offline'));
}

function loadSupabaseLib(){
  return new Promise((resolve,reject)=>{
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ============================================================
// NAME PICKER (replaces login)
// ============================================================
function getFamilyName(){
  try{ return localStorage.getItem(NAME_KEY) || null; }catch(e){ return null; }
}

async function pickFamilyName(name){
  try{ localStorage.setItem(NAME_KEY, name); }catch(e){}
  await afterNamePicked();
}

function forgetFamilyName(){
  try{ localStorage.removeItem(NAME_KEY); }catch(e){}
  setSyncBadge('signed-out');
}

async function afterNamePicked(){
  setSyncBadge('syncing');
  await pullChecklistState();
  await pullDecisionState();
  subscribeChecklistRealtime();
  subscribeDecisionRealtime();
  flushChecklistPending();
  flushDecisionPending();
  setSyncBadge('synced');
  if(typeof window.onSharedChecklistUpdated === 'function') window.onSharedChecklistUpdated();
  if(typeof window.onSharedDecisionsUpdated === 'function') window.onSharedDecisionsUpdated();
}

// ============================================================
// CHECKLIST STATE
// ============================================================
async function pullChecklistState(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('checklist_state').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] checklist pull failed', error); return; }
  SHARED_STATE = {};
  (data||[]).forEach(row => { SHARED_STATE[row.item_id] = row; });
}

function subscribeChecklistRealtime(){
  if(!supabaseClient || !currentWorkspaceId) return;
  if(checklistRealtimeChannel) supabaseClient.removeChannel(checklistRealtimeChannel);
  checklistRealtimeChannel = supabaseClient.channel('checklist-sync')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'checklist_state', filter: `workspace_id=eq.${currentWorkspaceId}` },
      payload => {
        const row = payload.new || payload.old;
        if(!row) return;
        if(payload.eventType === 'DELETE'){ delete SHARED_STATE[row.item_id]; }
        else { SHARED_STATE[row.item_id] = row; }
        if(typeof window.onSharedChecklistUpdated === 'function') window.onSharedChecklistUpdated();
      }
    ).subscribe();
}

async function setChecklistItemShared(itemId, isDone){
  const name = getFamilyName();
  const status = isDone ? 'DONE' : 'TO_DO';
  const row = {
    workspace_id: currentWorkspaceId,
    item_id: itemId,
    status,
    completed_by_name: isDone ? name : null,
    completed_at: isDone ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };
  SHARED_STATE[itemId] = row;
  if(typeof window.onSharedChecklistUpdated === 'function') window.onSharedChecklistUpdated();

  if(!navigator.onLine){ queueChecklistPending(itemId, status, name); setSyncBadge('offline'); return; }
  setSyncBadge('syncing');
  const { error } = await supabaseClient.from('checklist_state').upsert(row, { onConflict: 'workspace_id,item_id' });
  setSyncBadge(error ? 'offline' : 'synced');
  if(error) queueChecklistPending(itemId, status, name);
}

function queueChecklistPending(itemId, status, name){
  try{
    const q = JSON.parse(localStorage.getItem(CHECKLIST_PENDING_KEY) || '[]');
    const filtered = q.filter(p => p.item_id !== itemId);
    filtered.push({ item_id: itemId, status, name, ts: Date.now() });
    localStorage.setItem(CHECKLIST_PENDING_KEY, JSON.stringify(filtered));
  }catch(e){}
}

async function flushChecklistPending(){
  if(!SYNC_ENABLED || !supabaseClient || !currentWorkspaceId) return;
  let q = [];
  try{ q = JSON.parse(localStorage.getItem(CHECKLIST_PENDING_KEY) || '[]'); }catch(e){}
  if(q.length === 0) return;
  const latest = {};
  q.forEach(p => { if(!latest[p.item_id] || p.ts > latest[p.item_id].ts) latest[p.item_id] = p; });
  const rows = Object.values(latest).map(p => ({
    workspace_id: currentWorkspaceId, item_id: p.item_id, status: p.status,
    completed_by_name: p.status === 'DONE' ? p.name : null,
    completed_at: p.status === 'DONE' ? new Date(p.ts).toISOString() : null,
    updated_at: new Date().toISOString()
  }));
  const { error } = await supabaseClient.from('checklist_state').upsert(rows, { onConflict: 'workspace_id,item_id' });
  if(!error){ localStorage.removeItem(CHECKLIST_PENDING_KEY); await pullChecklistState(); }
}

// ============================================================
// DECISION STATE
// ============================================================
async function pullDecisionState(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('decision_state').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] decision pull failed', error); return; }
  SHARED_DECISION_STATE = {};
  (data||[]).forEach(row => { SHARED_DECISION_STATE[row.decision_id] = row; });
}

function subscribeDecisionRealtime(){
  if(!supabaseClient || !currentWorkspaceId) return;
  if(decisionRealtimeChannel) supabaseClient.removeChannel(decisionRealtimeChannel);
  decisionRealtimeChannel = supabaseClient.channel('decision-sync')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'decision_state', filter: `workspace_id=eq.${currentWorkspaceId}` },
      payload => {
        const row = payload.new || payload.old;
        if(!row) return;
        if(payload.eventType === 'DELETE'){ delete SHARED_DECISION_STATE[row.decision_id]; }
        else { SHARED_DECISION_STATE[row.decision_id] = row; }
        if(typeof window.onSharedDecisionsUpdated === 'function') window.onSharedDecisionsUpdated();
      }
    ).subscribe();
}

async function setDecisionStateShared(decisionId, fields){
  const name = getFamilyName();
  const row = Object.assign({
    workspace_id: currentWorkspaceId,
    decision_id: decisionId,
    updated_at: new Date().toISOString()
  }, fields);
  if('decided_at' in fields && fields.decided_at) row.decided_by_name = name;

  SHARED_DECISION_STATE[decisionId] = Object.assign({}, SHARED_DECISION_STATE[decisionId], row);
  if(typeof window.onSharedDecisionsUpdated === 'function') window.onSharedDecisionsUpdated();

  if(!navigator.onLine){ queueDecisionPending(decisionId, row); setSyncBadge('offline'); return; }
  setSyncBadge('syncing');
  const { error } = await supabaseClient.from('decision_state').upsert(row, { onConflict: 'workspace_id,decision_id' });
  setSyncBadge(error ? 'offline' : 'synced');
  if(error) queueDecisionPending(decisionId, row);
}

function queueDecisionPending(decisionId, fields){
  try{
    const q = JSON.parse(localStorage.getItem(DECISION_PENDING_KEY) || '[]');
    const filtered = q.filter(p => p.decision_id !== decisionId);
    filtered.push({ decision_id: decisionId, fields, ts: Date.now() });
    localStorage.setItem(DECISION_PENDING_KEY, JSON.stringify(filtered));
  }catch(e){}
}

async function flushDecisionPending(){
  if(!SYNC_ENABLED || !supabaseClient || !currentWorkspaceId) return;
  let q = [];
  try{ q = JSON.parse(localStorage.getItem(DECISION_PENDING_KEY) || '[]'); }catch(e){}
  if(q.length === 0) return;
  const latest = {};
  q.forEach(p => { if(!latest[p.decision_id] || p.ts > latest[p.decision_id].ts) latest[p.decision_id] = p; });
  const rows = Object.values(latest).map(p => Object.assign({
    workspace_id: currentWorkspaceId, decision_id: p.decision_id, updated_at: new Date(p.ts).toISOString()
  }, p.fields));
  const { error } = await supabaseClient.from('decision_state').upsert(rows, { onConflict: 'workspace_id,decision_id' });
  if(!error){ localStorage.removeItem(DECISION_PENDING_KEY); await pullDecisionState(); }
}

// ============================================================
// UI STATUS BADGE
// ============================================================
function setSyncBadge(state){
  const el = document.getElementById('essSyncBadge');
  if(!el) return;
  const map = {
    'local': { text: 'Apparaat-lokaal (geen gezinssync geconfigureerd)', cls: 'local' },
    'signed-out': { text: 'Kies je naam om te synchroniseren met je gezin', cls: 'signed-out' },
    'syncing': { text: 'Synchroniseren...', cls: 'syncing' },
    'synced': { text: 'Gesynchroniseerd als ' + (getFamilyName()||''), cls: 'synced' },
    'offline': { text: 'Offline — wijzigingen worden later gesynchroniseerd', cls: 'offline' }
  };
  const m = map[state] || map['local'];
  el.textContent = m.text;
  el.className = 'ess-sync-badge ' + m.cls;
}

window.KortesSync = {
  init: initSync,
  isEnabled: () => SYNC_ENABLED,
  isSignedIn: () => !!getFamilyName(),
  familyNames: FAMILY_NAMES,
  pickName: pickFamilyName,
  forgetName: forgetFamilyName,
  currentUserName: () => getFamilyName(),
  getSharedState: () => SHARED_STATE,
  setItem: setChecklistItemShared,
  decisions: {
    getSharedState: () => SHARED_DECISION_STATE,
    setState: setDecisionStateShared
  }
};
