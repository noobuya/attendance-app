'use strict';
// 온라인 공유 (Firebase). 관리자와 팀장이 같은 기록을 함께 봅니다.
// 데이터 구조 (orgs/{모임}):
//   members/{uid}        역할(admin|leader)과 담당 그룹
//   groups/{gid}         그룹 이름·색·팀장 이름·초대 코드
//   groups/{gid}/days/{날짜}  { marks: { 사람id: 상태 } }
//   people/{pid}         이름, 그룹
//   notices/{nid}        공지사항
// invites/{코드}          { orgId, role, groupId } 초대 코드 → 모임 연결

const Cloud = (() => {
  const SESSION_KEY = 'attendance-cloud-session';
  const NO_GROUP = '_none';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let db = null, auth = null, FV = null;
  let session = null;       // { orgId, role, groupId }
  let unsubs = [];
  let dayUnsubs = new Map(); // gid -> unsubscribe
  let loadedFrom = null;
  const dayDocs = new Map(); // `${gid}|${date}` -> marks
  let onChange = () => {};
  let onLeave = () => {};

  const state = { orgName: '', groups: [], people: [], notices: [], ready: false };

  function available() { return !!window.firebase && !!getConfig(); }
  function getConfig() {
    if (new URLSearchParams(location.search).has('emu')) return { apiKey: 'demo-key', projectId: 'demo-attendance', authDomain: 'localhost', appId: 'demo' };
    return window.FIREBASE_CONFIG || null;
  }

  function init() {
    if (!available() || db) return !!db;
    firebase.initializeApp(getConfig());
    auth = firebase.auth();
    db = firebase.firestore();
    FV = firebase.firestore.FieldValue;
    if (new URLSearchParams(location.search).has('emu')) {
      auth.useEmulator('http://localhost:9099', { disableWarnings: true });
      db.useEmulator('localhost', 8080);
    } else {
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    }
    return true;
  }

  async function signIn() {
    init();
    if (auth.currentUser) return auth.currentUser;
    await new Promise(res => { const u = auth.onAuthStateChanged(() => { u(); res(); }); });
    if (auth.currentUser) return auth.currentUser;
    return (await auth.signInAnonymously()).user;
  }

  const org = () => db.collection('orgs').doc(session.orgId);
  const gidOf = groupId => groupId || NO_GROUP;
  const isAdmin = () => session?.role === 'admin';

  function newCode() {
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    return [...buf].map(n => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }
  const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fmtCode = c => c ? c.slice(0, 4) + '-' + c.slice(4) : '';

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
    return session;
  }
  function saveSession() {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* 무시 */ }
  }

  // ---------- 모임 만들기 / 참여 ----------
  async function createOrg(name, local) {
    const user = await signIn();
    const orgRef = db.collection('orgs').doc();
    await orgRef.set({ name, ownerUid: user.uid, createdAt: FV.serverTimestamp() });
    await orgRef.collection('members').doc(user.uid).set({ role: 'admin', joinedAt: FV.serverTimestamp() });
    const adminCode = newCode();
    await db.collection('invites').doc(adminCode).set({ orgId: orgRef.id, role: 'admin' });
    await orgRef.update({ adminCode });
    session = { orgId: orgRef.id, role: 'admin', groupId: null };
    saveSession();
    if (local) await uploadLocal(local);
    return session;
  }

  async function uploadLocal({ groups, people, records }) {
    const ops = [];
    groups.forEach(g => ops.push(['set', org().collection('groups').doc(g.id), { name: g.name, color: g.color }]));
    people.forEach(p => ops.push(['set', org().collection('people').doc(p.id), { name: p.name, groupId: p.groupId || '' }]));
    const groupOf = new Map(people.map(p => [p.id, gidOf(p.groupId)]));
    for (const [date, rec] of Object.entries(records)) {
      const byGroup = {};
      for (const [pid, s] of Object.entries(rec)) {
        const gid = groupOf.get(pid);
        if (!gid) continue;
        (byGroup[gid] = byGroup[gid] || {})[pid] = s;
      }
      for (const [gid, marks] of Object.entries(byGroup)) {
        ops.push(['set', org().collection('groups').doc(gid).collection('days').doc(date), { marks }]);
      }
    }
    for (let i = 0; i < ops.length; i += 400) {
      const b = db.batch();
      ops.slice(i, i + 400).forEach(([, ref, v]) => b.set(ref, v));
      await b.commit();
    }
  }

  async function join(codeInput) {
    const code = normCode(codeInput);
    if (code.length !== 8) throw new Error('코드는 8자리입니다');
    const user = await signIn();
    const inv = await db.collection('invites').doc(code).get().catch(() => null);
    if (!inv || !inv.exists) throw new Error('없는 코드입니다. 다시 확인해 주세요');
    const { orgId, role, groupId = null } = inv.data();
    const member = { role, code, joinedAt: FV.serverTimestamp() };
    if (groupId) member.groupId = groupId;
    await db.collection('orgs').doc(orgId).collection('members').doc(user.uid).set(member);
    session = { orgId, role, groupId };
    saveSession();
    return session;
  }

  function leave() {
    stop();
    session = null;
    saveSession();
    auth?.signOut().catch(() => {});
  }

  // ---------- 실시간 받아오기 ----------
  function stop() {
    unsubs.forEach(u => u());
    unsubs = [];
    dayUnsubs.forEach(u => u());
    dayUnsubs.clear();
    dayDocs.clear();
    loadedFrom = null;
    Object.assign(state, { orgName: '', groups: [], people: [], notices: [], ready: false });
  }

  function lostAccess(err) {
    if (err?.code === 'permission-denied') {
      leave();
      onLeave('연결이 끊겼습니다. 관리자에게 새 코드를 받아 주세요');
    }
  }

  async function start(handlers) {
    onChange = handlers.onChange;
    onLeave = handlers.onLeave;
    if (!loadSession() || !init()) return false;
    await signIn();
    stop();
    const emit = () => onChange();

    unsubs.push(org().onSnapshot(s => { state.orgName = s.data()?.name || ''; state.adminCode = s.data()?.adminCode || ''; emit(); }, lostAccess));

    if (isAdmin()) {
      unsubs.push(org().collection('groups').onSnapshot(qs => {
        state.groups = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ko'));
        syncDayListeners();
        emit();
      }, lostAccess));
      unsubs.push(org().collection('people').onSnapshot(qs => {
        state.people = qs.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, lostAccess));
    } else {
      unsubs.push(org().collection('groups').doc(session.groupId).onSnapshot(s => {
        state.groups = s.exists ? [{ id: s.id, ...s.data() }] : [];
        if (!s.exists) { leave(); onLeave('담당 그룹이 삭제되었습니다'); return; }
        emit();
      }, lostAccess));
      unsubs.push(org().collection('people').where('groupId', '==', session.groupId).onSnapshot(qs => {
        state.people = qs.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, lostAccess));
    }
    unsubs.push(org().collection('notices').orderBy('createdAt', 'desc').limit(100).onSnapshot(qs => {
      state.notices = qs.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
        .filter(n => isAdmin() || !n.groupId || n.groupId === session.groupId);
      emit();
    }, lostAccess));

    ensureLoaded(addDays(today(), -60));
    syncDayListeners();
    state.ready = true;
    return true;
  }

  function visibleGroupIds() {
    return isAdmin() ? [...state.groups.map(g => g.id), NO_GROUP] : [session.groupId];
  }

  function syncDayListeners(force) {
    const want = new Set(visibleGroupIds());
    for (const [gid, u] of dayUnsubs) {
      if (force || !want.has(gid)) {
        u();
        dayUnsubs.delete(gid);
        for (const k of [...dayDocs.keys()]) if (k.startsWith(gid + '|')) dayDocs.delete(k);
      }
    }
    for (const gid of want) {
      if (dayUnsubs.has(gid)) continue;
      const q = org().collection('groups').doc(gid).collection('days')
        .where(firebase.firestore.FieldPath.documentId(), '>=', loadedFrom);
      dayUnsubs.set(gid, q.onSnapshot(qs => {
        qs.docChanges().forEach(ch => {
          const key = gid + '|' + ch.doc.id;
          if (ch.type === 'removed') dayDocs.delete(key);
          else dayDocs.set(key, ch.doc.data().marks || {});
        });
        onChange();
      }, lostAccess));
    }
  }

  // 화면에서 더 이전 날짜를 보려고 하면 그만큼 더 받아옵니다
  function ensureLoaded(date) {
    if (loadedFrom && date >= loadedFrom) return;
    loadedFrom = addDays(date, -30);
    if (db && session) syncDayListeners(true);
  }

  function records() {
    const out = {};
    for (const [key, marks] of dayDocs) {
      const date = key.slice(key.indexOf('|') + 1);
      const day = out[date] || (out[date] = {});
      Object.assign(day, marks);
    }
    return out;
  }

  // ---------- 쓰기 ----------
  const dayRef = (groupId, date) => org().collection('groups').doc(gidOf(groupId)).collection('days').doc(date);
  const fail = e => { console.error(e); window.toast?.(e?.code === 'permission-denied' ? '권한이 없습니다' : '저장하지 못했습니다. 인터넷 연결을 확인하세요'); };

  function setMarks(date, changes) { // changes: [{ person, status|null }]
    const byGroup = new Map();
    for (const { person, status } of changes) {
      const gid = gidOf(person.groupId);
      const m = byGroup.get(gid) || {};
      m[person.id] = status ? status : FV.delete();
      byGroup.set(gid, m);
    }
    const b = db.batch();
    for (const [gid, marks] of byGroup) b.set(dayRef(gid, date), { marks }, { merge: true });
    b.commit().catch(fail);
  }

  function addGroup(name, color) {
    org().collection('groups').add({ name, color, order: Date.now() }).catch(fail);
  }
  function renameGroup(id, name) { org().collection('groups').doc(id).update({ name }).catch(fail); }

  async function deleteGroup(id) {
    try {
      const g = state.groups.find(x => x.id === id);
      const b = db.batch();
      state.people.filter(p => p.groupId === id).forEach(p => b.update(org().collection('people').doc(p.id), { groupId: '' }));
      if (g?.leaderCode) b.delete(db.collection('invites').doc(g.leaderCode));
      b.delete(org().collection('groups').doc(id));
      await b.commit();
      await removeLeaders(id);
    } catch (e) { fail(e); }
  }

  async function removeLeaders(groupId) {
    const qs = await org().collection('members').where('groupId', '==', groupId).get();
    const b = db.batch();
    qs.docs.forEach(d => b.delete(d.ref));
    await b.commit();
  }

  // 팀장 지정: 새 초대 코드를 만들고, 이전 코드와 이전 팀장 연결은 끊습니다
  async function setLeader(groupId, leaderName) {
    const g = state.groups.find(x => x.id === groupId);
    const code = newCode();
    await db.collection('invites').doc(code).set({ orgId: session.orgId, role: 'leader', groupId });
    if (g?.leaderCode) await db.collection('invites').doc(g.leaderCode).delete().catch(() => {});
    await removeLeaders(groupId);
    await org().collection('groups').doc(groupId).update({ leaderName, leaderCode: code });
    return code;
  }
  async function clearLeader(groupId) {
    const g = state.groups.find(x => x.id === groupId);
    if (g?.leaderCode) await db.collection('invites').doc(g.leaderCode).delete().catch(() => {});
    await removeLeaders(groupId);
    await org().collection('groups').doc(groupId).update({ leaderName: FV.delete(), leaderCode: FV.delete() });
  }

  function addPerson(name, groupId) { org().collection('people').add({ name, groupId: groupId || '' }).catch(fail); }
  function updatePerson(id, name, groupId) { org().collection('people').doc(id).update({ name, groupId: groupId || '' }).catch(fail); }
  async function deletePerson(person) {
    try {
      const b = db.batch();
      b.delete(org().collection('people').doc(person.id));
      for (const [key, marks] of dayDocs) {
        if (marks[person.id] === undefined) continue;
        const [gid, date] = key.split('|');
        b.set(dayRef(gid, date), { marks: { [person.id]: FV.delete() } }, { merge: true });
      }
      await b.commit();
    } catch (e) { fail(e); }
  }

  function addNotice(title, body, groupId) {
    const n = { title, body, createdAt: FV.serverTimestamp() };
    if (groupId) n.groupId = groupId;
    org().collection('notices').add(n).catch(fail);
  }
  function deleteNotice(id) { org().collection('notices').doc(id).delete().catch(fail); }

  return {
    available, loadSession, get session() { return session; }, state, isAdmin,
    createOrg, join, leave, start, stop, ensureLoaded, records,
    setMarks, addGroup, renameGroup, deleteGroup, setLeader, clearLeader,
    addPerson, updatePerson, deletePerson, addNotice, deleteNotice,
    normCode, fmtCode, NO_GROUP,
  };
})();
