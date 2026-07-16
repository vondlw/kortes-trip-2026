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
const ROLE_KEY = 'kortes-trip-2026-role'; // 'family' | 'viewer'

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

  if(typeof window.onWorkspaceResolved === 'function') window.onWorkspaceResolved();

  if(getFamilyName()){
    await afterNamePicked();
  } else {
    setSyncBadge('signed-out');
  }

  window.addEventListener('online', () => { flushChecklistPending(); flushDecisionPending(); });
  window.addEventListener('offline', () => setSyncBadge('offline'));
}

// Wacht tot de workspace-ID bekend is (voorkomt "geen workspace"-fout als
// iemand heel snel klikt vlak na het openen van de app, terwijl de eerste
// verbinding met Supabase nog bezig is). Wacht max ~4 seconden.
function waitForWorkspace(timeoutMs){
  timeoutMs = timeoutMs || 4000;
  return new Promise((resolve) => {
    if(currentWorkspaceId){ resolve(true); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if(currentWorkspaceId){ clearInterval(check); resolve(true); }
      else if(Date.now() - start > timeoutMs){ clearInterval(check); resolve(false); }
    }, 150);
  });
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
  try{ localStorage.setItem(ROLE_KEY, 'family'); }catch(e){}
  await waitForWorkspace();
  if(currentWorkspaceId && FAMILY_NAMES.includes(name)){
    await claimName(name); // conflict = al geclaimd door iemand anders; negeren, deze persoon gebruikt 'm nu zelf
  }
  await afterNamePicked();
}

function forgetFamilyName(){
  try{ localStorage.removeItem(NAME_KEY); localStorage.removeItem(ROLE_KEY); }catch(e){}
  setSyncBadge('signed-out');
}

function getRole(){
  try{ return localStorage.getItem(ROLE_KEY) || 'family'; }catch(e){ return 'family'; }
}
function isViewer(){
  return getRole() === 'viewer';
}

async function getClaimedNames(){
  if(!supabaseClient || !currentWorkspaceId) return [];
  const { data, error } = await supabaseClient.from('claimed_names').select('name').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] claimed names fetch failed', error); return []; }
  return (data||[]).map(r => r.name);
}

async function claimName(name){
  if(!supabaseClient || !currentWorkspaceId) return { error: null };
  const { error } = await supabaseClient.from('claimed_names')
    .insert({ workspace_id: currentWorkspaceId, name })
    .select();
  return { error };
}

async function pickFamilyNameWithRole(name, role){
  try{ localStorage.setItem(ROLE_KEY, role); }catch(e){}
  try{ localStorage.setItem(NAME_KEY, name); }catch(e){}
  await waitForWorkspace();
  await afterNamePicked();
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
// VOTING — familie stemmen op activiteiten
// ============================================================
let SHARED_VOTES = {}; // decision_id -> { voterName: option }
let voteRealtimeChannel = null;

async function pullVotes(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('decision_votes').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] votes pull failed', error); return; }
  SHARED_VOTES = {};
  (data||[]).forEach(row => {
    if(!SHARED_VOTES[row.decision_id]) SHARED_VOTES[row.decision_id] = {};
    SHARED_VOTES[row.decision_id][row.voter_name] = row.option_voted;
  });
}

function subscribeVoteRealtime(){
  if(!supabaseClient || !currentWorkspaceId) return;
  if(voteRealtimeChannel) supabaseClient.removeChannel(voteRealtimeChannel);
  voteRealtimeChannel = supabaseClient.channel('vote-sync')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'decision_votes', filter: `workspace_id=eq.${currentWorkspaceId}` },
      payload => {
        const row = payload.new || payload.old;
        if(!row) return;
        if(!SHARED_VOTES[row.decision_id]) SHARED_VOTES[row.decision_id] = {};
        if(payload.eventType === 'DELETE'){ delete SHARED_VOTES[row.decision_id][row.voter_name]; }
        else { SHARED_VOTES[row.decision_id][row.voter_name] = row.option_voted; }
        if(typeof window.onSharedVotesUpdated === 'function') window.onSharedVotesUpdated();
      }
    ).subscribe();
}

async function castVote(decisionId, option){
  const name = getFamilyName();
  if(!name) return { error: 'Kies eerst je naam' };
  if(!SHARED_VOTES[decisionId]) SHARED_VOTES[decisionId] = {};
  SHARED_VOTES[decisionId][name] = option;
  if(typeof window.onSharedVotesUpdated === 'function') window.onSharedVotesUpdated();

  const row = {
    workspace_id: currentWorkspaceId,
    decision_id: decisionId,
    voter_name: name,
    option_voted: option,
    voted_at: new Date().toISOString()
  };
  if(!navigator.onLine){ return { error: null, offline: true }; }
  const { error } = await supabaseClient.from('decision_votes')
    .upsert(row, { onConflict: 'workspace_id,decision_id,voter_name' });
  return { error };
}

// ============================================================
// JOURNAAL — dagnotities, beoordelingen, bezocht-status, foto's
// ============================================================
let SHARED_JOURNAL = {};   // trip_day -> row
let SHARED_PHOTOS = {};    // trip_day -> [rows]
let journalRealtimeChannel = null;
let photoRealtimeChannel = null;
const STORAGE_BUCKET = 'journal-photos';

async function pullJournal(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('journal_entries').select('*').eq('workspace_id', currentWorkspaceId);
  if(error){ console.warn('[sync] journal pull failed', error); return; }
  SHARED_JOURNAL = {}; // trip_day -> { authorName: row }
  (data||[]).forEach(row => {
    if(!SHARED_JOURNAL[row.trip_day]) SHARED_JOURNAL[row.trip_day] = {};
    SHARED_JOURNAL[row.trip_day][row.author_name] = row;
  });
}

async function pullPhotos(){
  if(!currentWorkspaceId) return;
  const { data, error } = await supabaseClient
    .from('journal_photos').select('*').eq('workspace_id', currentWorkspaceId).order('created_at');
  if(error){ console.warn('[sync] photos pull failed', error); return; }
  SHARED_PHOTOS = {};
  (data||[]).forEach(row => {
    if(!SHARED_PHOTOS[row.trip_day]) SHARED_PHOTOS[row.trip_day] = [];
    SHARED_PHOTOS[row.trip_day].push(row);
  });
}

function subscribeJournalRealtime(){
  if(!supabaseClient || !currentWorkspaceId) return;
  if(journalRealtimeChannel) supabaseClient.removeChannel(journalRealtimeChannel);
  journalRealtimeChannel = supabaseClient.channel('journal-sync')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'journal_entries', filter: `workspace_id=eq.${currentWorkspaceId}` },
      payload => {
        const row = payload.new || payload.old;
        if(!row) return;
        if(!SHARED_JOURNAL[row.trip_day]) SHARED_JOURNAL[row.trip_day] = {};
        if(payload.eventType === 'DELETE'){ delete SHARED_JOURNAL[row.trip_day][row.author_name]; }
        else { SHARED_JOURNAL[row.trip_day][row.author_name] = row; }
        if(typeof window.onJournalUpdated === 'function') window.onJournalUpdated();
      }).subscribe();
  if(photoRealtimeChannel) supabaseClient.removeChannel(photoRealtimeChannel);
  photoRealtimeChannel = supabaseClient.channel('photo-sync')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'journal_photos', filter: `workspace_id=eq.${currentWorkspaceId}` },
      payload => {
        pullPhotos().then(() => { if(typeof window.onJournalUpdated === 'function') window.onJournalUpdated(); });
      }).subscribe();
}

async function saveJournalEntry(tripDay, fields){
  const name = getFamilyName();
  if(!name) return { error: { message: 'Kies eerst je naam' } };
  if(!currentWorkspaceId){
    const ready = await waitForWorkspace();
    if(!ready) return { error: { message: 'Kan geen verbinding maken met de database — check je internetverbinding en probeer opnieuw.' } };
  }
  const row = Object.assign({
    workspace_id: currentWorkspaceId,
    trip_day: tripDay,
    author_name: name,
    updated_at: new Date().toISOString()
  }, fields);
  if(!SHARED_JOURNAL[tripDay]) SHARED_JOURNAL[tripDay] = {};
  SHARED_JOURNAL[tripDay][name] = Object.assign({}, SHARED_JOURNAL[tripDay][name], row);
  if(typeof window.onJournalUpdated === 'function') window.onJournalUpdated();
  const { error } = await supabaseClient.from('journal_entries')
    .upsert(row, { onConflict: 'workspace_id,trip_day,author_name' });
  return { error };
}

function getJournalEntriesFor(tripDay){
  // alle notities/beoordelingen van iedereen voor deze dag, als array
  const byAuthor = SHARED_JOURNAL[tripDay] || {};
  return Object.values(byAuthor);
}
function getMyJournalEntry(tripDay){
  const name = getFamilyName();
  if(!name) return null;
  const byAuthor = SHARED_JOURNAL[tripDay] || {};
  return byAuthor[name] || null;
}
function getPhotosFor(tripDay){
  return SHARED_PHOTOS[tripDay] || [];
}

async function uploadJournalPhoto(tripDay, file, caption){
  if(!supabaseClient) return { error: { message: 'Sync niet geladen' } };
  if(!currentWorkspaceId){
    const ready = await waitForWorkspace();
    if(!ready) return { error: { message: 'Kan geen verbinding maken met de database — check je internetverbinding en probeer opnieuw.' } };
  }
  const name = getFamilyName();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${currentWorkspaceId}/${tripDay}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;

  const { error: uploadError } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: '3600', upsert: false
  });
  if(uploadError) return { error: uploadError };

  const row = {
    workspace_id: currentWorkspaceId, trip_day: tripDay, storage_path: path,
    caption: caption || null, uploaded_by_name: name
  };
  const { data, error } = await supabaseClient.from('journal_photos').insert(row).select().single();
  if(!error && data){
    if(!SHARED_PHOTOS[tripDay]) SHARED_PHOTOS[tripDay] = [];
    SHARED_PHOTOS[tripDay].push(data);
    if(typeof window.onJournalUpdated === 'function') window.onJournalUpdated();
  }
  return { error, photo: data };
}

function getPhotoUrl(storagePath){
  if(!supabaseClient) return '';
  const { data } = supabaseClient.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
  return data ? data.publicUrl : '';
}

async function deleteJournalPhoto(photoId, tripDay, storagePath){
  if(!supabaseClient) return;
  await supabaseClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
  await supabaseClient.from('journal_photos').delete().eq('id', photoId);
  if(SHARED_PHOTOS[tripDay]) SHARED_PHOTOS[tripDay] = SHARED_PHOTOS[tripDay].filter(p => p.id !== photoId);
  if(typeof window.onJournalUpdated === 'function') window.onJournalUpdated();
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
    'synced': { text: (isViewer() ? '👀 Meekijken als ' : 'Gesynchroniseerd als ') + (getFamilyName()||''), cls: 'synced' },
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
  pickNameWithRole: pickFamilyNameWithRole,
  forgetName: forgetFamilyName,
  currentUserName: () => getFamilyName(),
  isViewer: isViewer,
  getRole: getRole,
  getClaimedNames: getClaimedNames,
  claimName: claimName,
  getSharedState: () => SHARED_STATE,
  setItem: setChecklistItemShared,
  decisions: {
    getSharedState: () => SHARED_DECISION_STATE,
    setState: setDecisionStateShared
  },
  votes: {
    getSharedVotes: () => SHARED_VOTES,
    cast: castVote
  },
  journal: {
    getEntries: getJournalEntriesFor,
    getMyEntry: getMyJournalEntry,
    getPhotos: getPhotosFor,
    saveEntry: saveJournalEntry,
    uploadPhoto: uploadJournalPhoto,
    deletePhoto: deleteJournalPhoto,
    photoUrl: getPhotoUrl
  }
};
