/* ============================================================
   Kortes Trip 2026 — Gedeelde checklist-sync (Supabase)
   ============================================================
   Dit bestand is BEWUST optioneel. Zolang SUPABASE_URL/ANON_KEY
   hieronder leeg zijn, valt alles automatisch terug op de
   bestaande localStorage-only werking (device-only, zoals nu).

   Vul de twee onderstaande waarden in NA het volgen van
   05-dashboard/SUPABASE-SETUP.md. Gebruik ALLEEN de public
   anon-key — nooit de service_role key.
   ============================================================ */

const SUPABASE_URL = 'https://lyldstmxhyqgwsrhkxxj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5bGRzdG14aHlxZ3dzcmhreHhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NzYwMDAsImV4cCI6MjA5OTI1MjAwMH0.ggBQ1B84eVqOxXDmc1slwZTNjoFrjAtYSZfA2mNuffw';
const WORKSPACE_SLUG = 'kortes-2026';

const SYNC_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabaseClient = null;
let currentUser = null;
let currentWorkspaceId = null;
let realtimeChannel = null;
let pendingQueue = []; // offline queue: [{item_id, status}]

const PENDING_KEY = 'kortes-trip-2026-pending-sync';
const LEGACY_KEY = 'kortes-trip-2026-checklist-v1'; // local-only structure from V2

// ============================================================
// INIT
// ============================================================
async function initSync(){
  if(!SYNC_ENABLED){
    console.info('[sync] Supabase niet geconfigureerd — checklist blijft apparaat-lokaal.');
    setSyncBadge('local');
    return;
  }

  // Load supabase-js from CDN if not already present
  if(typeof window.supabase === 'undefined'){
    await loadSupabaseLib();
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'kortes-trip-2026-auth'
    }
  });

  // Restore session if present
  const { data: { session } } = await supabaseClient.auth.getSession();
  if(session){
    currentUser = session.user;
    await afterLogin();
  } else {
    setSyncBadge('signed-out');
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if(session){
      currentUser = session.user;
      await afterLogin();
    } else {
      currentUser = null;
      setSyncBadge('signed-out');
    }
  });

  window.addEventListener('online', flushPendingQueue);
  window.addEventListener('online', flushDecisionPendingQueue);
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

async function afterLogin(){
  setSyncBadge('syncing');
  // Resolve workspace id
  const { data: ws, error } = await supabaseClient
    .from('trip_workspaces').select('id').eq('slug', WORKSPACE_SLUG).single();
  if(error || !ws){
    console.warn('[sync] workspace niet gevonden — controleer setup.', error);
    setSyncBadge('local');
    return;
  }
  currentWorkspaceId = ws.id;

  await migrateLocalStateIfNeeded();
  await pullSharedState();
  subscribeRealtime();
  flushPendingQueue();
  await migrateDecisionStateIfNeeded();
  await pullDecisionState();
  subscribeDecisionRealtime();
  flushDecisionPendingQueue();
  setSyncBadge('synced');
}

// ============================================================
// MAGIC LINK LOGIN
// ============================================================
async function requestLoginCode(email){
  if(!SYNC_ENABLED || !supabaseClient) return { error: 'Sync niet geconfigureerd' };
  // shouldCreateUser:false zou nieuwe emails weigeren; we laten Supabase de bestaande
  // gezinsleden (al aangemaakt in Users) gewoon een code sturen.
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  return { error };
}

async function verifyLoginCode(email, code){
  if(!SYNC_ENABLED || !supabaseClient) return { error: 'Sync niet geconfigureerd' };
  const { data, error } = await supabaseClient.auth.verifyOtp({
    email, token: code, type: 'email'
  });
  if(!error && data.session){
    currentUser = data.session.user;
    await afterLogin();
  }
  return { error };
}

async function signOutFamily(){
  if(supabaseClient) await supabaseClient.auth.signOut();
}

// ============================================================
// MIGRATION — one-time import of existing local DONE items
// ============================================================
async function migrateLocalStateIfNeeded(){
  const migratedFlag = localStorage.getItem('kortes-trip-2026-migrated-to-shared');
  if(migratedFlag) return;

  let localState = {};
  try{ localState = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}'); }catch(e){}

  const doneIds = Object.keys(localState).filter(id => localState[id] && localState[id].status === 'DONE');
  if(doneIds.length === 0){
    localStorage.setItem('kortes-trip-2026-migrated-to-shared','true');
    return;
  }

  const rows = doneIds.map(item_id => ({
    workspace_id: currentWorkspaceId,
    item_id,
    status: 'DONE',
    completed_by: currentUser.id,
    completed_at: localState[item_id].completedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabaseClient.from('checklist_state').upsert(rows, { onConflict: 'workspace_id,item_id' });
  if(!error){
    localStorage.setItem('kortes-trip-2026-migrated-to-shared','true');
    console.info(`[sync] ${doneIds.length} lokale items gemigreerd naar gedeelde checklist.`);
  }
}

// ============================================================
// SHARED STATE — pull / push / realtime
// ============================================================
let SHARED_STATE = {}; // item_id -> {status, completed_by, completed_at}

async function pullSharedState(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('checklist_state').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] pull failed', error); return; }
  SHARED_STATE = {};
  (data||[]).forEach(row => { SHARED_STATE[row.item_id] = row; });
  if(typeof window.onSharedChecklistUpdated === 'function') window.onSharedChecklistUpdated();
}

function subscribeRealtime(){
  if(!supabaseClient || !currentWorkspaceId) return;
  if(realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient.channel('checklist-sync')
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
  const status = isDone ? 'DONE' : 'TO_DO';
  const row = {
    workspace_id: currentWorkspaceId,
    item_id: itemId,
    status,
    completed_by: isDone ? currentUser.id : null,
    completed_at: isDone ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  // Optimistic local update
  SHARED_STATE[itemId] = row;
  if(typeof window.onSharedChecklistUpdated === 'function') window.onSharedChecklistUpdated();

  if(!navigator.onLine){
    queuePending(itemId, status);
    setSyncBadge('offline');
    return;
  }

  setSyncBadge('syncing');
  const { error } = await supabaseClient.from('checklist_state')
    .upsert(row, { onConflict: 'workspace_id,item_id' });
  if(error){
    console.warn('[sync] push failed, queueing', error);
    queuePending(itemId, status);
    setSyncBadge('offline');
  } else {
    setSyncBadge('synced');
  }
}

function queuePending(itemId, status){
  try{
    const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    const filtered = q.filter(p => p.item_id !== itemId);
    filtered.push({ item_id: itemId, status, ts: Date.now() });
    localStorage.setItem(PENDING_KEY, JSON.stringify(filtered));
  }catch(e){}
}

async function flushPendingQueue(){
  if(!SYNC_ENABLED || !supabaseClient || !currentWorkspaceId || !currentUser) return;
  let q = [];
  try{ q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); }catch(e){}
  if(q.length === 0) return;

  setSyncBadge('syncing');
  // Latest-valid-update-wins: dedupe by item_id keeping last ts
  const latest = {};
  q.forEach(p => { if(!latest[p.item_id] || p.ts > latest[p.item_id].ts) latest[p.item_id] = p; });

  const rows = Object.values(latest).map(p => ({
    workspace_id: currentWorkspaceId,
    item_id: p.item_id,
    status: p.status,
    completed_by: p.status === 'DONE' ? currentUser.id : null,
    completed_at: p.status === 'DONE' ? new Date(p.ts).toISOString() : null,
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabaseClient.from('checklist_state').upsert(rows, { onConflict: 'workspace_id,item_id' });
  if(!error){
    localStorage.removeItem(PENDING_KEY);
    await pullSharedState();
    setSyncBadge('synced');
  } else {
    setSyncBadge('offline');
  }
}

// ============================================================
// DECISION STATE — parallel sync system (same pattern as checklist)
// ============================================================
let SHARED_DECISION_STATE = {};
let decisionRealtimeChannel = null;
const DECISION_PENDING_KEY = 'kortes-trip-2026-pending-decision-sync';
const DECISION_LEGACY_KEY = 'kortes-trip-2026-decisions-v1';

function loadLocalDecisionState(){
  try{ return JSON.parse(localStorage.getItem(DECISION_LEGACY_KEY) || '{}'); }catch(e){ return {}; }
}
function saveLocalDecisionState(state){
  try{ localStorage.setItem(DECISION_LEGACY_KEY, JSON.stringify(state)); }catch(e){}
}

async function pullDecisionState(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('decision_state').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] decision pull failed', error); return; }
  SHARED_DECISION_STATE = {};
  (data||[]).forEach(row => { SHARED_DECISION_STATE[row.decision_id] = row; });
  if(typeof window.onSharedDecisionsUpdated === 'function') window.onSharedDecisionsUpdated();
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
  const row = Object.assign({
    workspace_id: currentWorkspaceId,
    decision_id: decisionId,
    updated_at: new Date().toISOString()
  }, fields);

  SHARED_DECISION_STATE[decisionId] = Object.assign({}, SHARED_DECISION_STATE[decisionId], row);
  if(typeof window.onSharedDecisionsUpdated === 'function') window.onSharedDecisionsUpdated();

  if(!navigator.onLine){
    queueDecisionPending(decisionId, fields);
    setSyncBadge('offline');
    return;
  }
  setSyncBadge('syncing');
  const { error } = await supabaseClient.from('decision_state')
    .upsert(row, { onConflict: 'workspace_id,decision_id' });
  if(error){
    console.warn('[sync] decision push failed, queueing', error);
    queueDecisionPending(decisionId, fields);
    setSyncBadge('offline');
  } else {
    setSyncBadge('synced');
  }
}

function queueDecisionPending(decisionId, fields){
  try{
    const q = JSON.parse(localStorage.getItem(DECISION_PENDING_KEY) || '[]');
    const filtered = q.filter(p => p.decision_id !== decisionId);
    filtered.push({ decision_id: decisionId, fields, ts: Date.now() });
    localStorage.setItem(DECISION_PENDING_KEY, JSON.stringify(filtered));
  }catch(e){}
}

async function flushDecisionPendingQueue(){
  if(!SYNC_ENABLED || !supabaseClient || !currentWorkspaceId) return;
  let q = [];
  try{ q = JSON.parse(localStorage.getItem(DECISION_PENDING_KEY) || '[]'); }catch(e){}
  if(q.length === 0) return;
  setSyncBadge('syncing');
  const latest = {};
  q.forEach(p => { if(!latest[p.decision_id] || p.ts > latest[p.decision_id].ts) latest[p.decision_id] = p; });
  const rows = Object.values(latest).map(p => Object.assign({
    workspace_id: currentWorkspaceId, decision_id: p.decision_id, updated_at: new Date(p.ts).toISOString()
  }, p.fields));
  const { error } = await supabaseClient.from('decision_state').upsert(rows, { onConflict: 'workspace_id,decision_id' });
  if(!error){
    localStorage.removeItem(DECISION_PENDING_KEY);
    await pullDecisionState();
    setSyncBadge('synced');
  } else {
    setSyncBadge('offline');
  }
}

async function migrateDecisionStateIfNeeded(){
  const flag = localStorage.getItem('kortes-trip-2026-decisions-migrated');
  if(flag) return;
  const local = loadLocalDecisionState();
  const ids = Object.keys(local);
  if(ids.length === 0){ localStorage.setItem('kortes-trip-2026-decisions-migrated','true'); return; }
  const rows = ids.map(id => Object.assign({
    workspace_id: currentWorkspaceId, decision_id: id, updated_at: new Date().toISOString()
  }, local[id]));
  const { error } = await supabaseClient.from('decision_state').upsert(rows, { onConflict: 'workspace_id,decision_id' });
  if(!error) localStorage.setItem('kortes-trip-2026-decisions-migrated','true');
}

// ============================================================
// UI STATUS BADGE
// ============================================================
function setSyncBadge(state){
  const el = document.getElementById('essSyncBadge');
  if(!el) return;
  const map = {
    'local': { text: 'Apparaat-lokaal (geen gezinssync geconfigureerd)', cls: 'local' },
    'signed-out': { text: 'Log in om te synchroniseren met je gezin', cls: 'signed-out' },
    'syncing': { text: 'Synchroniseren...', cls: 'syncing' },
    'synced': { text: 'Gesynchroniseerd', cls: 'synced' },
    'offline': { text: 'Offline — wijzigingen worden later gesynchroniseerd', cls: 'offline' }
  };
  const m = map[state] || map['local'];
  el.textContent = m.text;
  el.className = 'ess-sync-badge ' + m.cls;
}

// Expose minimal API to index.html
window.KortesSync = {
  init: initSync,
  isEnabled: () => SYNC_ENABLED,
  isSignedIn: () => !!currentUser,
  requestLoginCode,
  verifyLoginCode,
  signOut: signOutFamily,
  getSharedState: () => SHARED_STATE,
  setItem: setChecklistItemShared,
  currentUserName: () => currentUser ? (currentUser.user_metadata?.display_name || currentUser.email) : null,
  currentUserId: () => currentUser ? currentUser.id : null,
  decisions: {
    getSharedState: () => SHARED_DECISION_STATE,
    setState: setDecisionStateShared,
    getLocalState: loadLocalDecisionState,
    setLocalState: saveLocalDecisionState
  }
};
