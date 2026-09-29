'use strict';

// ---------- 상태 정의 ----------
const STATUSES = [
  { key: 'P', label: '출석', short: '출', color: '#16a34a' },
  { key: 'L', label: '지각', short: '지', color: '#f59e0b' },
  { key: 'E', label: '조퇴', short: '조', color: '#8b5cf6' },
  { key: 'A', label: '결석', short: '결', color: '#ef4444' },
  { key: 'X', label: '공결', short: '공', color: '#0ea5e9' },
];
const STATUS = Object.fromEntries(STATUSES.map(s => [s.key, s]));
// 출석률: 결석이 아닌 기록 ÷ 전체 기록 (지각·조퇴·공결은 출석으로 셈)
const isAttended = k => k && k !== 'A';
const GROUP_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4b5563'];

// ---------- 저장소 ----------
const STORE_KEY = 'attendance-app-v1';
const emptyData = () => ({ groups: [], people: [], records: {} });
let data = load();
const cloudOn = () => !!Cloud.session;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { groups: d.groups || [], people: d.people || [], records: d.records || {} };
    }
  } catch (e) { /* 무시하고 새로 시작 */ }
  return emptyData();
}
function save() {
  if (cloudOn()) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch (e) { toast('저장 공간이 부족해 저장하지 못했습니다'); }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- 날짜 도우미 ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const shortDate = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
function daysBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let s = from; s <= to && out.length < 400; s = addDays(s, 1)) out.push(s);
  return out;
}

// ---------- 화면 상태 ----------
const ui = {
  tab: 'check',
  checkDate: today(),
  checkGroup: 'all',
  viewGroup: 'all',
  from: addDays(today(), -6),
  to: today(),
};
const charts = {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const groupById = id => data.groups.find(g => g.id === id);
const groupName = id => groupById(id)?.name || '그룹 없음';
const groupColor = id => groupById(id)?.color || '#9ca3af';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

function peopleIn(groupId) {
  const list = groupId === 'all' ? data.people : data.people.filter(p => (p.groupId || '') === groupId);
  const order = new Map(data.groups.map((g, i) => [g.id, i]));
  return [...list].sort((a, b) =>
    (order.get(a.groupId) ?? 999) - (order.get(b.groupId) ?? 999) || a.name.localeCompare(b.name, 'ko'));
}

// ---------- 탭 ----------
const TITLES = { check: '출결 입력', table: '출결표', stats: '그래프', notice: '공지사항', manage: '관리' };
function showTab(tab) {
  ui.tab = tab;
  $$('.tab').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#pageTitle').textContent = TITLES[tab];
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (ui.tab === 'check') renderCheck();
  if (ui.tab === 'table') renderTable();
  if (ui.tab === 'stats') renderStats();
  if (ui.tab === 'notice') renderNotices();
  if (ui.tab === 'manage') renderManage();
  renderNoticeBadge();
}

function renderGroupChips(el, current, onPick) {
  const items = [{ id: 'all', name: '전체' }, ...data.groups];
  if (data.people.some(p => !p.groupId)) items.push({ id: '', name: '그룹 없음' });
  el.innerHTML = items.map(g =>
    `<button class="chip ${g.id === current ? 'active' : ''}" data-id="${esc(g.id)}">${esc(g.name)}</button>`).join('');
  el.querySelectorAll('.chip').forEach(b => b.onclick = () => onPick(b.dataset.id));
}

// ---------- 출결 입력 ----------
function renderCheck() {
  if (cloudOn()) Cloud.ensureLoaded(ui.checkDate);
  $('#checkDate').value = ui.checkDate;
  renderGroupChips($('#checkGroupChips'), ui.checkGroup, id => { ui.checkGroup = id; renderCheck(); });

  const people = peopleIn(ui.checkGroup);
  const day = data.records[ui.checkDate] || {};
  const list = $('#checkList');

  if (!data.people.length) {
    list.innerHTML = `<li class="empty-state">아직 등록된 사람이 없습니다.<br>아래 <b>관리</b> 탭에서 그룹과 사람을 추가하세요.</li>`;
    $('#checkSummary').innerHTML = '';
    return;
  }

  const counts = {};
  people.forEach(p => { const s = day[p.id]; if (s) counts[s] = (counts[s] || 0) + 1; });
  const unmarked = people.filter(p => !day[p.id]).length;
  const d = parse(ui.checkDate);
  $('#checkSummary').innerHTML =
    `<span class="muted" style="margin:0 4px 0 0">${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})</span>` +
    STATUSES.filter(s => counts[s.key]).map(s => `<span class="badge" style="background:${s.color}">${s.label} ${counts[s.key]}</span>`).join('') +
    (unmarked ? `<span class="badge" style="background:#9ca3af">미입력 ${unmarked}</span>` : '');

  let html = '', lastGroup = null;
  for (const p of people) {
    if (ui.checkGroup === 'all' && p.groupId !== lastGroup) {
      lastGroup = p.groupId;
      html += `<li class="group-divider"><span class="dot" style="background:${groupColor(p.groupId)}"></span>${esc(groupName(p.groupId))}</li>`;
    }
    const cur = day[p.id];
    html += `<li class="person" data-id="${p.id}">
      <div class="person-head"><span class="person-name">${esc(p.name)}</span><span class="person-group">${cur ? STATUS[cur].label : '미입력'}</span></div>
      <div class="status-btns">${STATUSES.map(s =>
        `<button data-s="${s.key}" class="${cur === s.key ? 'on' : ''}" style="${cur === s.key ? `background:${s.color}` : `color:${s.color}`}">${s.label}</button>`).join('')}
      </div></li>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('.person').forEach(li => {
    li.querySelectorAll('button').forEach(b => b.onclick = () => setStatus(li.dataset.id, b.dataset.s));
  });
}

function setStatus(personId, s) {
  if (cloudOn()) {
    const person = data.people.find(p => p.id === personId);
    const cur = data.records[ui.checkDate]?.[personId];
    return Cloud.setMarks(ui.checkDate, [{ person, status: cur === s ? null : s }]);
  }
  const day = data.records[ui.checkDate] || (data.records[ui.checkDate] = {});
  if (day[personId] === s) delete day[personId]; // 같은 버튼 다시 누르면 취소
  else day[personId] = s;
  if (!Object.keys(day).length) delete data.records[ui.checkDate];
  save();
  renderCheck();
}

// ---------- 기간 선택 (출결표/그래프 공용) ----------
const PRESETS = [
  ['오늘', () => [today(), today()]],
  ['최근 7일', () => [addDays(today(), -6), today()]],
  ['이번 주', () => { const d = new Date(); const off = (d.getDay() + 6) % 7; const mon = addDays(today(), -off); return [mon, addDays(mon, 6)]; }],
  ['이번 달', () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }],
  ['지난 달', () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))]; }],
  ['최근 30일', () => [addDays(today(), -29), today()]],
];

function setupRangeControls() {
  $$('.presets').forEach(el => {
    el.innerHTML = PRESETS.map(([name], i) => `<button data-i="${i}">${name}</button>`).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      [ui.from, ui.to] = PRESETS[b.dataset.i][1]();
      render();
    });
  });
  $$('.rangeFrom').forEach(inp => inp.onchange = () => { if (inp.value) { ui.from = inp.value; if (ui.to < ui.from) ui.to = ui.from; render(); } });
  $$('.rangeTo').forEach(inp => inp.onchange = () => { if (inp.value) { ui.to = inp.value; if (ui.from > ui.to) ui.from = ui.to; render(); } });
}
function syncRangeInputs() {
  $$('.rangeFrom').forEach(i => i.value = ui.from);
  $$('.rangeTo').forEach(i => i.value = ui.to);
}

// 기간·그룹 기준 집계
function aggregate() {
  const days = daysBetween(ui.from, ui.to);
  const people = peopleIn(ui.viewGroup);
  const perPerson = new Map(people.map(p => [p.id, { total: 0, attended: 0 }]));
  const totals = Object.fromEntries(STATUSES.map(s => [s.key, 0]));
  const perDay = [];
  for (const day of days) {
    const rec = data.records[day] || {};
    let dayTotal = 0, dayAtt = 0;
    for (const p of people) {
      const s = rec[p.id];
      if (!s) continue;
      totals[s]++;
      dayTotal++;
      const pp = perPerson.get(p.id);
      pp.total++;
      pp[s] = (pp[s] || 0) + 1;
      if (isAttended(s)) { dayAtt++; pp.attended++; }
    }
    perDay.push({ day, total: dayTotal, rate: dayTotal ? Math.round(dayAtt / dayTotal * 1000) / 10 : null });
  }
  return { days, people, perPerson, totals, perDay };
}
const rate = (att, total) => total ? Math.round(att / total * 1000) / 10 : null;

// ---------- 출결표 ----------
function renderTable() {
  if (cloudOn()) Cloud.ensureLoaded(ui.from);
  syncRangeInputs();
  renderGroupChips($('#tableGroupChips'), ui.viewGroup, id => { ui.viewGroup = id; renderTable(); });
  $('#tableLegend').innerHTML = STATUSES.map(s => `<span><span class="dot" style="background:${s.color}"></span>${s.short}=${s.label}</span>`).join('');

  const { days, people, perPerson } = aggregate();
  const t = $('#attTable'), st = $('#sumTable');
  if (!people.length) {
    t.innerHTML = `<tr><td class="empty-state">표시할 사람이 없습니다</td></tr>`;
    st.innerHTML = '';
    return;
  }
  if (days.length > 120) toast('기간이 길어 표가 넓어질 수 있습니다');

  let head = '<tr><th>이름</th>' + days.map(d => {
    const w = parse(d).getDay();
    const color = w === 0 ? 'color:#ef4444' : w === 6 ? 'color:#2563eb' : '';
    return `<th style="${color}">${shortDate(d)}<br>${WEEK[w]}</th>`;
  }).join('') + '</tr>';
  let body = '';
  for (const p of people) {
    body += `<tr><td>${esc(p.name)}</td>` + days.map(d => {
      const s = data.records[d]?.[p.id];
      return s ? `<td class="cell" style="background:${STATUS[s].color}">${STATUS[s].short}</td>` : `<td class="cell empty">·</td>`;
    }).join('') + '</tr>';
  }
  t.innerHTML = head + body;

  st.innerHTML = '<tr><th>이름</th><th>그룹</th>' + STATUSES.map(s => `<th>${s.label}</th>`).join('') + '<th>출석률</th></tr>' +
    people.map(p => {
      const pp = perPerson.get(p.id);
      const r = rate(pp.attended, pp.total);
      return `<tr><td>${esc(p.name)}</td><td>${esc(groupName(p.groupId))}</td>` +
        STATUSES.map(s => `<td>${pp[s.key] || 0}</td>`).join('') +
        `<td><b>${r === null ? '-' : r + '%'}</b></td></tr>`;
    }).join('');
}

function exportCsv() {
  const { days, people, perPerson } = aggregate();
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['이름', '그룹', ...days, ...STATUSES.map(s => s.label), '출석률(%)']];
  for (const p of people) {
    const pp = perPerson.get(p.id);
    rows.push([p.name, groupName(p.groupId), ...days.map(d => STATUS[data.records[d]?.[p.id]]?.label || ''),
      ...STATUSES.map(s => pp[s.key] || 0), rate(pp.attended, pp.total) ?? '']);
  }
  const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  saveFile(`출결표_${ui.from}_${ui.to}.csv`, csv, 'text/csv');
}

// ---------- 이미지로 공유 ----------
const FONT = () => getComputedStyle(document.body).fontFamily;
const rangeLabel = () => {
  const f = parse(ui.from), t = parse(ui.to);
  const fmt = d => `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}(${WEEK[d.getDay()]})`;
  return ui.from === ui.to ? fmt(f) : `${fmt(f)} ~ ${fmt(t)}`;
};
const viewGroupLabel = () => ui.viewGroup === 'all' ? '전체' : groupName(ui.viewGroup);

function newImage(w, h) {
  const c = document.createElement('canvas');
  const scale = 2;
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.textBaseline = 'middle';
  return { c, g };
}
function text(g, str, x, y, { size = 13, weight = 400, color = '#1c2230', align = 'left' } = {}) {
  g.font = `${weight} ${size}px ${FONT()}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(str, x, y);
}
function drawHeader(g, w, title) {
  g.fillStyle = '#2563eb';
  g.fillRect(0, 0, w, 64);
  text(g, title, 16, 24, { size: 18, weight: 700, color: '#fff' });
  text(g, `${rangeLabel()} · ${viewGroupLabel()}`, 16, 47, { size: 13, color: '#dbe6ff' });
}

function tableImage() {
  const { days, people, perPerson } = aggregate();
  const nameW = 76, cellW = 30, rowH = 30, headH = 40, sumW = 34, rateW = 56, pad = 16;
  const sumCols = STATUSES.length;
  const w = Math.max(360, pad * 2 + nameW + days.length * cellW + sumCols * sumW + rateW);
  const tableTop = 64 + 14;
  const h = tableTop + headH + people.length * rowH + 56;
  const { c, g } = newImage(w, h);
  drawHeader(g, w, '출결표');

  let x = pad, y = tableTop;
  g.fillStyle = '#e7eefe';
  g.fillRect(pad, y, w - pad * 2, headH);
  text(g, '이름', x + 8, y + headH / 2, { size: 12, weight: 700 });
  x += nameW;
  for (const d of days) {
    const wd = parse(d).getDay();
    const col = wd === 0 ? '#ef4444' : wd === 6 ? '#2563eb' : '#1c2230';
    text(g, shortDate(d), x + cellW / 2, y + 13, { size: 10, weight: 600, color: col, align: 'center' });
    text(g, WEEK[wd], x + cellW / 2, y + 28, { size: 10, color: col, align: 'center' });
    x += cellW;
  }
  for (const s of STATUSES) {
    text(g, s.label, x + sumW / 2, y + headH / 2, { size: 11, weight: 700, color: s.color, align: 'center' });
    x += sumW;
  }
  text(g, '출석률', x + rateW / 2, y + headH / 2, { size: 11, weight: 700, align: 'center' });

  y += headH;
  let lastGroup = null;
  for (const p of people) {
    x = pad;
    if (ui.viewGroup === 'all' && p.groupId !== lastGroup && lastGroup !== null) {
      g.fillStyle = '#9aa3b5';
      g.fillRect(pad, y - 1, w - pad * 2, 2);
    }
    lastGroup = p.groupId;
    g.fillStyle = groupColor(p.groupId);
    g.fillRect(x, y + 6, 3, rowH - 12);
    text(g, p.name, x + 8, y + rowH / 2, { size: 13, weight: 600 });
    x += nameW;
    for (const d of days) {
      const s = data.records[d]?.[p.id];
      if (s) {
        g.fillStyle = STATUS[s].color;
        g.fillRect(x + 1, y + 1, cellW - 2, rowH - 2);
        text(g, STATUS[s].short, x + cellW / 2, y + rowH / 2, { size: 12, weight: 700, color: '#fff', align: 'center' });
      } else {
        text(g, '·', x + cellW / 2, y + rowH / 2, { size: 12, color: '#b0b6c3', align: 'center' });
      }
      x += cellW;
    }
    const pp = perPerson.get(p.id);
    for (const s of STATUSES) {
      const n = pp[s.key] || 0;
      text(g, String(n), x + sumW / 2, y + rowH / 2, { size: 12, weight: n ? 700 : 400, color: n ? '#1c2230' : '#b0b6c3', align: 'center' });
      x += sumW;
    }
    const r = rate(pp.attended, pp.total);
    text(g, r === null ? '-' : r + '%', x + rateW / 2, y + rowH / 2, { size: 12, weight: 700,
      color: r === null ? '#b0b6c3' : r >= 90 ? '#16a34a' : r >= 70 ? '#d97706' : '#ef4444', align: 'center' });
    g.fillStyle = '#e3e7ef';
    g.fillRect(pad, y + rowH - 0.5, w - pad * 2, 1);
    y += rowH;
  }

  // 범례
  x = pad; y += 26;
  for (const s of STATUSES) {
    g.fillStyle = s.color;
    g.fillRect(x, y - 6, 12, 12);
    text(g, `${s.short}=${s.label}`, x + 16, y, { size: 11, color: '#6b7385' });
    x += 70;
  }
  return c;
}

function statsImage() {
  const { totals } = aggregate();
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const w = 420, pad = 16, inner = w - pad * 2;
  const blocks = [
    ['상태별 비율', charts.pie],
    ['날짜별 출석률', charts.line],
    ['그룹별 출결', charts.group],
    ['사람별 출석률', charts.person],
  ].filter(([, ch]) => ch).map(([title, ch]) => ({ title, canvas: ch.canvas, h: inner * ch.canvas.height / ch.canvas.width }));
  const h = 64 + 16 + 64 + blocks.reduce((a, b) => a + b.h + 44, 0) + 8;
  const { c, g } = newImage(w, h);
  drawHeader(g, w, '출결 통계');

  let y = 80;
  const kpis = [
    [total ? rate(total - totals.A, total) + '%' : '-', '출석률', '#1c2230'],
    [String(totals.L), '지각', STATUS.L.color],
    [String(totals.A), '결석', STATUS.A.color],
  ];
  const kw = (inner - 16) / 3;
  kpis.forEach(([v, label, col], i) => {
    const x = pad + i * (kw + 8);
    g.fillStyle = '#f4f6fa';
    g.fillRect(x, y, kw, 56);
    text(g, v, x + kw / 2, y + 22, { size: 20, weight: 700, color: col, align: 'center' });
    text(g, label, x + kw / 2, y + 44, { size: 11, color: '#6b7385', align: 'center' });
  });
  y += 64 + 12;
  for (const b of blocks) {
    text(g, b.title, pad, y + 12, { size: 14, weight: 700 });
    g.drawImage(b.canvas, pad, y + 28, inner, b.h);
    y += b.h + 44;
  }
  return c;
}

async function shareImage(canvas, filename) {
  const dataUrl = canvas.toDataURL('image/png');
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) {
    try {
      const { Filesystem, Share } = cap.Plugins;
      const res = await Filesystem.writeFile({ path: filename, data: dataUrl.split(',')[1], directory: 'CACHE' });
      await Share.share({ title: filename, files: [res.uri], dialogTitle: '이미지 보내기' });
    } catch (e) {
      if (!String(e?.message || e).toLowerCase().includes('cancel')) toast('이미지를 공유하지 못했습니다');
    }
    return;
  }
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); }
    catch (e) { if (e.name !== 'AbortError') toast('이미지를 공유하지 못했습니다'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('이미지를 저장했습니다');
}

// ---------- 그래프 ----------
function makeChart(key, canvas, config) {
  charts[key]?.destroy();
  charts[key] = new Chart(canvas, config);
}

function renderStats() {
  if (cloudOn()) Cloud.ensureLoaded(ui.from);
  syncRangeInputs();
  renderGroupChips($('#statsGroupChips'), ui.viewGroup, id => { ui.viewGroup = id; renderStats(); });
  const { people, perPerson, totals, perDay } = aggregate();

  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const attended = total - totals.A;
  $('#kpis').innerHTML = `
    <div class="kpi"><b>${total ? rate(attended, total) + '%' : '-'}</b><small>출석률</small></div>
    <div class="kpi"><b style="color:${STATUS.L.color}">${totals.L}</b><small>지각</small></div>
    <div class="kpi"><b style="color:${STATUS.A.color}">${totals.A}</b><small>결석</small></div>`;

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  Chart.defaults.color = dark ? '#97a0b3' : '#6b7385';
  Chart.defaults.borderColor = dark ? '#2a3446' : '#e3e7ef';
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  makeChart('pie', $('#chartPie'), {
    type: 'doughnut',
    data: {
      labels: STATUSES.map(s => s.label),
      datasets: [{ data: STATUSES.map(s => totals[s.key]), backgroundColor: STATUSES.map(s => s.color), borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { position: 'right' },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${c.raw}건 (${total ? Math.round(c.raw / total * 100) : 0}%)` } },
      },
    },
  });

  makeChart('line', $('#chartLine'), {
    type: 'line',
    data: {
      labels: perDay.map(d => shortDate(d.day)),
      datasets: [{ label: '출석률(%)', data: perDay.map(d => d.rate), borderColor: '#2563eb', backgroundColor: '#2563eb22',
        fill: true, tension: .3, spanGaps: true, pointRadius: perDay.length > 40 ? 0 : 3 }],
    },
    options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } }, plugins: { legend: { display: false } } },
  });

  // 그룹별: 선택한 그룹 필터와 상관없이 전체 그룹 비교
  const groupIds = [...data.groups.map(g => g.id), ...(data.people.some(p => !p.groupId) ? [''] : [])];
  const days = daysBetween(ui.from, ui.to);
  const gCounts = groupIds.map(gid => {
    const ids = new Set(data.people.filter(p => (p.groupId || '') === gid).map(p => p.id));
    const c = Object.fromEntries(STATUSES.map(s => [s.key, 0]));
    for (const d of days) for (const [pid, s] of Object.entries(data.records[d] || {})) if (ids.has(pid)) c[s]++;
    return c;
  });
  makeChart('group', $('#chartGroup'), {
    type: 'bar',
    data: {
      labels: groupIds.map(groupName),
      datasets: STATUSES.map(s => ({ label: s.label, data: gCounts.map(c => c[s.key]), backgroundColor: s.color })),
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'bottom' } } },
  });

  const ranked = people.map(p => ({ p, r: rate(perPerson.get(p.id).attended, perPerson.get(p.id).total) }))
    .filter(x => x.r !== null).sort((a, b) => a.r - b.r);
  const box = $('#personChartBox');
  box.style.height = Math.max(120, ranked.length * 28 + 50) + 'px';
  makeChart('person', $('#chartPerson'), {
    type: 'bar',
    data: {
      labels: ranked.map(x => x.p.name),
      datasets: [{ label: '출석률(%)', data: ranked.map(x => x.r),
        backgroundColor: ranked.map(x => x.r >= 90 ? '#16a34a' : x.r >= 70 ? '#f59e0b' : '#ef4444') }],
    },
    options: { indexAxis: 'y', maintainAspectRatio: false, scales: { x: { min: 0, max: 100, ticks: { callback: v => v + '%' } } },
      plugins: { legend: { display: false } } },
  });
}

// ---------- 공지사항 ----------
const APK_URL = 'https://github.com/noobuya/attendance-app/releases/download/latest/default.apk';
const WEB_URL = 'https://noobuya.github.io/attendance-app/';
const SEEN_KEY = 'attendance-notice-seen';
const noticeTime = n => n.createdAt?.toMillis?.() ?? Date.now();
const fmtDateTime = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function renderNoticeBadge() {
  const btn = $('.tabbar button[data-tab=notice]');
  btn.hidden = !cloudOn();
  let seen = 0;
  try { seen = Number(localStorage.getItem(SEEN_KEY) || 0); } catch { /* 무시 */ }
  const unread = cloudOn() && ui.tab !== 'notice' ? Cloud.state.notices.filter(n => noticeTime(n) > seen).length : 0;
  const badge = btn.querySelector('.tab-badge');
  badge.textContent = unread > 9 ? '9+' : unread;
  badge.hidden = !unread;
  $('.tabbar').style.gridTemplateColumns = `repeat(${cloudOn() ? 5 : 4}, 1fr)`;
}

function renderNotices() {
  const admin = Cloud.isAdmin();
  $('#noticeForm').hidden = !admin;
  if (admin) {
    const sel = $('#noticeGroup');
    const keep = sel.value;
    sel.innerHTML = '<option value="">모든 팀장에게</option>' + data.groups.map(g => `<option value="${g.id}">${esc(g.name)} 팀장에게만</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  }
  const list = Cloud.state.notices;
  $('#noticeList').innerHTML = list.map(n => `
    <li class="notice" data-id="${n.id}">
      <div class="notice-head"><b>${esc(n.title)}</b><small>${fmtDateTime(noticeTime(n))}</small></div>
      ${n.groupId ? `<span class="badge" style="background:${groupColor(n.groupId)}">${esc(groupName(n.groupId))}</span>` : ''}
      <p>${esc(n.body).replace(/\n/g, '<br>')}</p>
      ${admin ? '<button class="del">삭제</button>' : ''}
    </li>`).join('') || '<li class="empty-state">아직 공지사항이 없습니다</li>';
  $$('#noticeList .del').forEach(b => b.onclick = () => {
    if (confirm('이 공지를 삭제할까요?')) Cloud.deleteNotice(b.closest('li').dataset.id);
  });
  const newest = list.length ? Math.max(...list.map(noticeTime)) : 0;
  try { localStorage.setItem(SEEN_KEY, String(Math.max(newest, Date.now()))); } catch { /* 무시 */ }
}

// ---------- 관리 ----------
function renderManage() {
  const admin = !cloudOn() || Cloud.isAdmin();
  const leader = cloudOn() && !Cloud.isAdmin();
  renderConnect();

  $('#groupCard').hidden = leader;
  const gl = $('#groupList');
  gl.innerHTML = data.groups.map(g => {
    const n = data.people.filter(p => p.groupId === g.id).length;
    const leaderLine = cloudOn()
      ? `<div class="leader-line">${g.leaderName
          ? `팀장 <b>${esc(g.leaderName)}</b> · 코드 <code>${Cloud.fmtCode(g.leaderCode)}</code>
             <button class="share">초대 보내기</button><button class="setLeader">변경</button><button class="clearLeader">해제</button>`
          : `팀장 없음 <button class="setLeader">팀장 지정</button>`}</div>`
      : '';
    return `<li data-id="${g.id}" class="group-item"><div class="group-row"><span class="dot" style="background:${g.color}"></span><span class="grow">${esc(g.name)} <small>${n}명</small></span>
      <button class="edit">이름 변경</button><button class="del">삭제</button></div>${leaderLine}</li>`;
  }).join('') || '<li class="muted">그룹이 없습니다. 예: 1반, 2반, 오전반</li>';
  gl.querySelectorAll('li[data-id]').forEach(li => {
    const g = groupById(li.dataset.id);
    li.querySelector('.edit').onclick = () => openEdit('그룹 이름 변경', g.name, null, name => {
      if (cloudOn()) return Cloud.renameGroup(g.id, name);
      g.name = name;
    });
    li.querySelector('.del').onclick = () => {
      if (!confirm(`'${g.name}' 그룹을 삭제할까요?\n소속된 사람은 '그룹 없음'으로 옮겨집니다.${g.leaderName ? '\n팀장 연결도 끊어집니다.' : ''}`)) return;
      if (cloudOn()) return Cloud.deleteGroup(g.id);
      data.people.forEach(p => { if (p.groupId === g.id) p.groupId = ''; });
      data.groups = data.groups.filter(x => x !== g);
      save(); renderManage();
    };
    li.querySelector('.setLeader')?.addEventListener('click', () => setLeaderFlow(g));
    li.querySelector('.share')?.addEventListener('click', () => shareInvite(g));
    li.querySelector('.clearLeader')?.addEventListener('click', async () => {
      if (!confirm(`${g.leaderName} 팀장을 해제할까요?\n그 팀장은 더 이상 앱에서 이 그룹을 볼 수 없습니다.`)) return;
      try { await Cloud.clearLeader(g.id); toast('팀장을 해제했습니다'); } catch (e) { console.error(e); toast('해제하지 못했습니다'); }
    });
  });

  const sel = $('#personGroup');
  sel.hidden = leader;
  const opts = (leader ? '' : '<option value="">그룹 없음</option>') + data.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  const keep = sel.value;
  sel.innerHTML = opts;
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  else if (data.groups.length) sel.value = data.groups[0].id;

  const pl = $('#personList');
  pl.innerHTML = peopleIn('all').map(p =>
    `<li data-id="${p.id}"><span class="dot" style="background:${groupColor(p.groupId)}"></span><span class="grow">${esc(p.name)} <small>${esc(groupName(p.groupId))}</small></span>
      <button class="edit">수정</button><button class="del">삭제</button></li>`).join('') || '<li class="muted">사람이 없습니다</li>';
  pl.querySelectorAll('li[data-id]').forEach(li => {
    const p = data.people.find(x => x.id === li.dataset.id);
    li.querySelector('.edit').onclick = () => openEdit('사람 수정', p.name, leader ? null : p.groupId, (name, gid) => {
      if (cloudOn()) return Cloud.updatePerson(p.id, name, leader ? p.groupId : gid);
      p.name = name; p.groupId = gid;
    });
    li.querySelector('.del').onclick = () => {
      if (!confirm(`'${p.name}'님을 삭제할까요?\n이 사람의 출결 기록도 함께 지워집니다.`)) return;
      if (cloudOn()) return Cloud.deletePerson(p);
      data.people = data.people.filter(x => x !== p);
      for (const [d, rec] of Object.entries(data.records)) { delete rec[p.id]; if (!Object.keys(rec).length) delete data.records[d]; }
      save(); renderManage();
    };
  });

  $('#localDataActions').hidden = cloudOn();
  $('#dataNote').textContent = cloudOn()
    ? '기록은 온라인에 저장되어 관리자와 팀장이 함께 봅니다. 필요하면 백업 파일로도 저장할 수 있어요.'
    : '기록은 이 폰 안에만 저장됩니다. 폰을 바꾸거나 앱을 지우기 전에 백업해 두세요.';
  $('#dataCard').hidden = leader;
}

function renderConnect() {
  const box = $('#connectCard');
  if (!Cloud.available()) { box.hidden = true; return; }
  box.hidden = false;
  if (!cloudOn()) {
    box.innerHTML = `<h3>팀장과 함께 쓰기</h3>
      <p class="muted">모임을 만들면 그룹마다 팀장을 정하고, 팀장이 자기 폰에서 출석을 체크할 수 있어요. 공지사항도 보낼 수 있어요.</p>
      <div class="row-actions">
        <button class="btn small" id="createOrgBtn">새 모임 만들기 (관리자)</button>
        <button class="btn small ghost" id="joinBtn">초대 코드 입력 (팀장)</button>
      </div>`;
    $('#createOrgBtn').onclick = createOrgFlow;
    $('#joinBtn').onclick = () => joinFlow();
    return;
  }
  const st = Cloud.state;
  const admin = Cloud.isAdmin();
  const myGroup = !admin ? data.groups[0] : null;
  box.innerHTML = `<h3>${esc(st.orgName || '모임')} <small class="role-badge">${admin ? '관리자' : '팀장'}</small></h3>
    <p class="muted">${admin ? '모든 그룹을 관리하고 공지를 올릴 수 있어요.' : `<b>${esc(myGroup?.name || '')}</b> 그룹 출석을 체크하고 공지를 볼 수 있어요.`}</p>
    <div class="row-actions">
      ${admin ? '<button class="btn small ghost" id="adminCodeBtn">다른 폰에서 관리자로 쓰기</button>' : ''}
      <button class="btn small danger" id="leaveBtn">연결 해제</button>
    </div>`;
  $('#adminCodeBtn')?.addEventListener('click', () => {
    alert(`관리자 코드: ${Cloud.fmtCode(st.adminCode)}\n\n다른 폰에서 앱을 열고 '초대 코드 입력'에 이 코드를 넣으면 관리자로 연결됩니다.\n이 코드는 다른 사람에게 알려주지 마세요.`);
  });
  $('#leaveBtn').onclick = () => {
    if (!confirm(admin ? '이 폰에서 모임 연결을 해제할까요?\n온라인 기록은 지워지지 않고, 관리자 코드로 다시 연결할 수 있어요.' : '이 폰에서 연결을 해제할까요?\n다시 쓰려면 초대 코드를 다시 넣어야 해요.')) return;
    Cloud.leave();
    data = load();
    toast('연결을 해제했습니다');
    showTab('manage');
  };
}

async function createOrgFlow() {
  const name = prompt('모임 이름을 입력하세요 (예: ○○교회 청년부)');
  if (!name?.trim()) return;
  const hasLocal = data.people.length > 0;
  const upload = hasLocal && confirm(`이 폰에 있는 그룹 ${data.groups.length}개, 사람 ${data.people.length}명과 출결 기록을 새 모임으로 옮길까요?`);
  try {
    toast('모임을 만드는 중...');
    await Cloud.createOrg(name.trim(), upload ? load() : null);
    await startCloud();
    toast('모임을 만들었습니다. 그룹마다 팀장을 지정해 보세요');
    showTab('manage');
  } catch (e) { console.error(e); toast('모임을 만들지 못했습니다. 인터넷 연결을 확인하세요'); }
}

async function joinFlow(prefill) {
  const code = prefill || prompt('받은 초대 코드 8자리를 입력하세요');
  if (!code) return;
  try {
    toast('연결하는 중...');
    await Cloud.join(code);
    await startCloud();
    toast(Cloud.isAdmin() ? '관리자로 연결되었습니다' : '팀장으로 연결되었습니다');
    showTab(Cloud.isAdmin() ? 'manage' : 'check');
  } catch (e) { console.error(e); toast(e.message && !e.code ? e.message : '연결하지 못했습니다. 코드를 확인하세요'); }
}

async function setLeaderFlow(g) {
  const name = prompt(`${g.name} 그룹의 팀장 이름을 입력하세요`, g.leaderName || '');
  if (!name?.trim()) return;
  if (g.leaderName && !confirm('팀장을 바꾸면 새 초대 코드가 만들어지고, 이전 코드와 이전 팀장의 연결은 끊어집니다. 계속할까요?')) return;
  try {
    const code = await Cloud.setLeader(g.id, name.trim());
    shareInvite({ ...g, leaderName: name.trim(), leaderCode: code });
  } catch (e) { console.error(e); toast('팀장을 지정하지 못했습니다'); }
}

async function shareInvite(g) {
  const code = Cloud.fmtCode(g.leaderCode);
  const msg = `[출결 관리] ${Cloud.state.orgName} ${g.name} 팀장 초대\n${g.leaderName}님, 아래 순서로 연결해 주세요.\n\n` +
    `1) 앱 설치\n- 안드로이드: ${APK_URL}\n- 아이폰: Safari로 ${WEB_URL}?code=${g.leaderCode} 열고 공유 → 홈 화면에 추가\n\n` +
    `2) 앱 → 관리 → '초대 코드 입력'에 코드 입력\n코드: ${code}`;
  const cap = window.Capacitor;
  try {
    if (cap?.isNativePlatform?.()) return await cap.Plugins.Share.share({ text: msg, dialogTitle: '초대 보내기' });
    if (navigator.share) return await navigator.share({ text: msg });
  } catch (e) { if (e?.name === 'AbortError' || String(e?.message).toLowerCase().includes('cancel')) return; }
  try { await navigator.clipboard.writeText(msg); toast('초대 메시지를 복사했습니다. 카톡에 붙여 넣으세요'); }
  catch { alert(msg); }
}

function openEdit(title, name, groupId, onSave) {
  const dlg = $('#editDialog');
  $('#editTitle').textContent = title;
  $('#editName').value = name;
  const sel = $('#editGroup');
  sel.hidden = groupId === null;
  sel.innerHTML = '<option value="">그룹 없음</option>' + data.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = groupId || '';
  dlg.onclose = () => {
    const v = $('#editName').value.trim();
    if (dlg.returnValue === 'ok' && v) { onSave(v, sel.value); save(); renderManage(); }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- 파일 저장 (앱에서는 공유 시트, 브라우저에서는 다운로드) ----------
async function saveFile(filename, text, mime) {
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) {
    try {
      const { Filesystem, Share } = cap.Plugins;
      const b64 = btoa(unescape(encodeURIComponent(text)));
      const res = await Filesystem.writeFile({ path: filename, data: b64, directory: 'CACHE' });
      await Share.share({ title: filename, url: res.uri, dialogTitle: '파일 저장/보내기' });
      return;
    } catch (e) {
      if (String(e?.message || e).includes('cancel')) return;
      toast('파일을 내보내지 못했습니다');
      return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadSample() {
  const names = [['1반', ['김민준', '이서연', '박도윤', '최하은', '정시우']],
                 ['2반', ['강지호', '윤서아', '임하준', '한지유']],
                 ['3반', ['오은우', '서지안', '신예준', '권수아', '황도현']]];
  for (const [gname, people] of names) {
    let g = data.groups.find(x => x.name === gname);
    if (!g) { g = { id: uid(), name: gname, color: GROUP_COLORS[data.groups.length % GROUP_COLORS.length] }; data.groups.push(g); }
    for (const n of people) if (!data.people.some(p => p.name === n)) data.people.push({ id: uid(), name: n, groupId: g.id });
  }
  const weights = [['P', 78], ['L', 10], ['E', 4], ['A', 5], ['X', 3]];
  const pick = () => { let r = Math.random() * 100; for (const [k, w] of weights) { if ((r -= w) < 0) return k; } return 'P'; };
  for (let i = 0; i < 30; i++) {
    const d = addDays(today(), -i);
    const w = parse(d).getDay();
    if (w === 0 || w === 6) continue;
    const rec = data.records[d] || (data.records[d] = {});
    for (const p of data.people) if (!rec[p.id]) rec[p.id] = pick();
  }
  save();
  toast('예시 데이터를 넣었습니다');
  renderManage();
}

// ---------- 온라인 연결 ----------
let renderQueued = false;
function cloudChanged() {
  data = { groups: Cloud.state.groups, people: Cloud.state.people, records: Cloud.records() };
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
async function startCloud() {
  const ok = await Cloud.start({
    onChange: cloudChanged,
    onLeave: msg => { data = load(); toast(msg); showTab('manage'); },
  });
  if (ok) cloudChanged();
  return ok;
}

// ---------- 이벤트 연결 ----------
function init() {
  $$('.tabbar button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  $('#checkDate').onchange = e => { if (e.target.value) { ui.checkDate = e.target.value; renderCheck(); } };
  $('#prevDay').onclick = () => { ui.checkDate = addDays(ui.checkDate, -1); renderCheck(); };
  $('#nextDay').onclick = () => { ui.checkDate = addDays(ui.checkDate, 1); renderCheck(); };
  $('#allPresent').onclick = () => {
    const people = peopleIn(ui.checkGroup);
    if (!people.length) return;
    const day = data.records[ui.checkDate] || {};
    const todo = people.filter(p => !day[p.id]);
    if (cloudOn()) Cloud.setMarks(ui.checkDate, todo.map(person => ({ person, status: 'P' })));
    else {
      data.records[ui.checkDate] = day;
      todo.forEach(p => { day[p.id] = 'P'; });
      save(); renderCheck();
    }
    toast('미입력자를 모두 출석 처리했습니다');
  };
  $('#clearDay').onclick = () => {
    const day = data.records[ui.checkDate];
    if (!day) return;
    if (!confirm('이 날짜의 (현재 보이는 그룹) 기록을 지울까요?')) return;
    const people = peopleIn(ui.checkGroup).filter(p => day[p.id]);
    if (cloudOn()) return Cloud.setMarks(ui.checkDate, people.map(person => ({ person, status: null })));
    people.forEach(p => delete day[p.id]);
    if (!Object.keys(day).length) delete data.records[ui.checkDate];
    save(); renderCheck();
  };

  setupRangeControls();
  $('#exportCsv').onclick = exportCsv;
  $('#shareTableImg').onclick = () => {
    if (!peopleIn(ui.viewGroup).length) return toast('표시할 사람이 없습니다');
    shareImage(tableImage(), `출결표_${ui.from}_${ui.to}.png`);
  };
  $('#shareStatsImg').onclick = () => shareImage(statsImage(), `출결통계_${ui.from}_${ui.to}.png`);

  $('#noticeForm').onsubmit = e => {
    e.preventDefault();
    const title = $('#noticeTitle').value.trim(), body = $('#noticeBody').value.trim();
    if (!title) return;
    Cloud.addNotice(title, body, $('#noticeGroup').value);
    $('#noticeTitle').value = ''; $('#noticeBody').value = '';
    toast('공지를 올렸습니다');
  };

  $('#groupForm').onsubmit = e => {
    e.preventDefault();
    const name = $('#groupName').value.trim();
    if (!name) return;
    const color = GROUP_COLORS[data.groups.length % GROUP_COLORS.length];
    $('#groupName').value = '';
    if (cloudOn()) return Cloud.addGroup(name, color);
    const g = { id: uid(), name, color };
    data.groups.push(g);
    save(); renderManage();
    $('#personGroup').value = g.id;
  };
  $('#personForm').onsubmit = e => {
    e.preventDefault();
    const name = $('#personName').value.trim();
    if (!name) return;
    const groupId = cloudOn() && !Cloud.isAdmin() ? Cloud.session.groupId : $('#personGroup').value;
    $('#personName').value = '';
    $('#personName').focus();
    toast(`${name} 추가됨`);
    if (cloudOn()) return Cloud.addPerson(name, groupId);
    data.people.push({ id: uid(), name, groupId });
    save(); renderManage();
  };

  $('#backupBtn').onclick = () => saveFile(`출결백업_${today()}.json`, JSON.stringify(data), 'application/json');
  $('#restoreInput').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.people) || !Array.isArray(d.groups) || typeof d.records !== 'object') throw 0;
      if (!confirm('지금 데이터를 백업 파일 내용으로 바꿀까요?')) return;
      data = { groups: d.groups, people: d.people, records: d.records };
      save(); renderManage(); toast('백업을 불러왔습니다');
    } catch { toast('올바른 백업 파일이 아닙니다'); }
  };
  $('#sampleBtn').onclick = loadSample;
  $('#resetBtn').onclick = () => {
    if (!confirm('모든 그룹, 사람, 출결 기록을 지울까요? 되돌릴 수 없습니다.')) return;
    data = emptyData(); save(); renderManage(); toast('초기화했습니다');
  };

  // 안드로이드 뒤로가기: 첫 탭이 아니면 첫 탭으로
  window.Capacitor?.Plugins?.App?.addListener?.('backButton', () => {
    if ($('#editDialog').open) $('#editDialog').close();
    else if (ui.tab !== 'check') showTab('check');
    else window.Capacitor.Plugins.App.exitApp();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor?.isNativePlatform?.()) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const codeParam = new URLSearchParams(location.search).get('code');
  const connected = Cloud.loadSession();
  showTab(connected || data.people.length ? 'check' : 'manage');
  if (connected) startCloud().catch(e => { console.error(e); toast('온라인 연결에 실패했습니다'); });
  else if (codeParam && Cloud.available()) joinFlow(codeParam);
}

init();
