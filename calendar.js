const DAY = 86400000;
// Adapt legacy mixed labels for display without changing the public data schema.
export function entryTypes(entry) {
  const types = [...new Set((entry.types || []).filter(type => !['奖学金', '研究岗位'].includes(type)))];
  if (types.length) return types;
  if (entry.types?.includes('研究岗位')) {
    const title = entry.title || '';
    if (/博士后|\bpost[\s-]?doc(?:toral|torate)?\b/i.test(title)) return ['博士后'];
    if (/研究助理|\bresearch\s+assistant\b/i.test(title)) return ['RA／研究助理'];
    if (/研究员|\bresearch\s+(?:fellow|scientist)\b/i.test(title)) return ['研究员'];
    return ['研究岗位（待细分）'];
  }
  return ['未注明学位/岗位'];
}
export function entryFunding(entry) { return entry.types?.includes('奖学金') ? ['奖学金'] : []; }
// Navigation groups are broader than the role labels retained on each card.
export function entryCategories(entry) {
  return [...new Set(entryTypes(entry).map(type => ['教职', '研究员'].includes(type) ? '教职／研究员' : type))];
}
const TIMELINE_LABELS = {
  application_verified_current: '已核具体轮次', application_verified_recurring: '已核年度规则',
  application_verified_rolling: '已核滚动规则', application_verified_position_based: '随岗位公告申请',
  official_not_announced: '官网明确尚未公布', unresolved_conflict: '信息有冲突，待确认',
  source_unavailable: '官网读取失败，待核实', not_found_in_checked_sources: '已查来源未找到时间',
  not_accepting: '本轮不招生', discontinued: '项目已停办', source_changed: '来源已变化，待复核',
};
const EVENT_LABELS = { application_open: '申请开放', application_deadline: '申请截止', funding_deadline: '资助截止', document_deadline: '材料／前置截止' };
export function timelineLabel(entry) { return TIMELINE_LABELS[entry.timeline?.status] || ''; }
// Labels come from reviewed structured states, never from missing dates or prose guesses.
export function timingStatus(entry) {
  const state = entry.timeline?.status;
  let application = { key: 'unverified', label: '没核实到', detail: timelineLabel(entry) || '缺少可确认的申请时间依据' };
  if (state === 'official_not_announced') application = { key: 'not_announced', label: '尚未公布', detail: '官网明确未公布本轮时间' };
  else if (state === 'application_verified_rolling') application = { key: 'no_fixed', label: '没有固定截止', detail: '已核滚动申请规则；可能满额提前关闭' };
  else if (state === 'application_verified_position_based') application = { key: 'position_based', label: '随岗位公告', detail: '各岗位有各自期限，不代表岗位没有截止' };
  else if (state === 'application_verified_recurring') application = { key: 'annual', label: '年度轮次', detail: '已核年度规则，具体年份和节点见说明' };
  else if (state === 'application_verified_current') application = { key: 'verified', label: '已核本轮时间', detail: '已核部分日期；材料及资格限制仍请看说明' };
  else if (['not_accepting', 'discontinued'].includes(state)) application = { key: 'inactive', label: timelineLabel(entry), detail: '' };
  else if (!entry.timeline && entry.record_kind !== 'program') {
    if (entry.deadline) application = { key: 'verified', label: '已核日期', detail: '核验日期与历史状态见来源说明' };
    else if (entry.timing === 'annual') application = { key: 'annual', label: '年度轮次参考', detail: '不是本年度已确认截止日' };
    else if (entry.timing === 'rolling') application.detail = '有滚动线索，本轮规则仍需核实';
  }
  const fundingState = entry.timeline?.funding_timeline.status;
  const funding = fundingState ? {
    key: fundingState === 'not_announced' ? 'not_announced' : fundingState === 'unverified' ? 'unverified' : fundingState,
    label: { verified: '已核部分日期／规则', not_announced: '尚未公布', unverified: '没核实到', not_applicable: '不适用', not_offered_by_programme: '项目暂无专属资助' }[fundingState],
    detail: entry.timeline.funding_timeline.note || '',
  } : null;
  return { application, funding };
}
function statusSummary(entry) {
  const { application, funding } = timingStatus(entry);
  return `<strong>申请：${escape(application.label)}</strong><small>${escape(application.detail)}</small>`
    + (funding ? `<strong>资助：${escape(funding.label)}</strong><small>${funding.key === 'verified' ? '仅部分方案已有依据，不代表全部资助已核清。' : funding.key === 'not_announced' ? '已核为待公布，后续继续复核。' : funding.key === 'unverified' ? '未确认可靠时间依据，具体原因见申请说明。' : '适用范围见申请说明。'}</small>` : '')
    + (entry.timeline?.gaps.length ? `<small class="calendar-gap">仍有 ${entry.timeline.gaps.length} 项说明／缺口，展开“时间线与申请说明”查看。</small>` : '');
}
export function timelineEvents(entry) {
  const timeline = entry.timeline;
  if (!timeline || ['source_changed', 'unresolved_conflict', 'not_accepting', 'discontinued'].includes(timeline.status)) return [];
  const applicationVerified = timeline.status.startsWith('application_verified_');
  return timeline.events.filter(event => event.date && event.kind !== 'application_open' && !event.is_historical
    && (applicationVerified || (event.kind === 'funding_deadline' && timeline.funding_timeline.status === 'verified'))).map((event, i) => ({
    ...entry, id: `${entry.id}-event-${i}`, parent_id: entry.id, deadline: event.date, timezone: event.timezone,
    deadline_at: event.deadline_at, timing: 'dated', source_url: event.source_url,
    date_note: `${EVENT_LABELS[event.kind]} · ${event.scope}${event.time_text ? ' · '+event.time_text : ''}`,
    note: entry.timeline.intake_label, event_kind: event.kind,
  }));
}
export function displayEntry(entry, now = new Date(), status = '') {
  const all = timelineEvents(entry);
  const events = ['past', 'upcoming'].includes(status) ? all.filter(e => deadlineState(e, now) === status) : all;
  if (!events.length && all.length) return displayEntry(entry, now);
  if (!events.length) return entry;
  const next = sortEntries(events, 'countdown', 1, now)[0];
  return { ...next, id: entry.id, note: entry.note, date_note: `最近一个已核节点：${next.date_note}` };
}
export function dateInZone(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
export function sourceZoneLabel(entry) {
  if (!entry.timezone) return '';
  const when = entry.deadline || entry.date;
  if (!when && !entry.timezone.startsWith('Etc/')) return entry.timezone;
  const instant = when ? new Date(when+'T12:00:00Z') : new Date();
  return new Intl.DateTimeFormat('zh-CN', { timeZone: entry.timezone, timeZoneName: 'shortOffset' }).formatToParts(instant).find(p => p.type === 'timeZoneName').value.replace('GMT','UTC');
}
export function daysRemaining(entry, now = new Date()) {
  if (!entry.deadline) return null;
  return Math.round((Date.parse(entry.deadline + 'T00:00:00Z') - Date.parse(dateInZone(now, entry.timezone) + 'T00:00:00Z')) / DAY);
}
export function deadlineState(entry, now = new Date()) {
  const days = daysRemaining(entry, now);
  if (days === null) return 'undated';
  if (entry.deadline_at && Date.parse(entry.deadline_at) <= now.getTime()) return 'past';
  return days < 0 ? 'past' : 'upcoming';
}
export function countdown(entry, now = new Date()) {
  const days = daysRemaining(entry, now);
  if (days === null) return timelineLabel(entry) || (entry.timing === 'annual' ? '年度轮次参考' : entry.timing === 'rolling' ? '滚动 · 待核实' : '截止日期未核实');
  if (deadlineState(entry, now) === 'past') return days < 0 ? `日期已过 ${Math.abs(days)} 天` : '截止时刻已过';
  return days === 0 ? (entry.timezone ? '来源当地今天' : '约在今天') : `${entry.timezone ? '还剩' : '约剩'} ${days} 天`;
}
export function sortEntries(entries, key = 'countdown', direction = 1, now = new Date()) {
  const text = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true });
  return [...entries].sort((a, b) => {
    let result = 0;
    if (key === 'name') result = text(a.title, b.title);
    else if (key === 'country') result = text(a.country, b.country);
    else if (key === 'type') result = text(entryTypes(a).join(' / '), entryTypes(b).join(' / '));
    else {
      // Unknown dates always stay last, including reverse chronological order.
      if (!a.deadline || !b.deadline) return a.deadline ? -1 : b.deadline ? 1 : text(a.title, b.title);
      if (key === 'countdown') {
        const rank = e => deadlineState(e, now) === 'upcoming' ? 0 : 1;
        result = rank(a) - rank(b);
        if (!result) result = deadlineState(a, now) === 'upcoming'
          ? daysRemaining(a, now) - daysRemaining(b, now)
          : daysRemaining(b, now) - daysRemaining(a, now);
        if (!result && a.deadline_at && b.deadline_at) result = (Date.parse(a.deadline_at) - Date.parse(b.deadline_at)) * (deadlineState(a, now) === 'upcoming' ? 1 : -1);
      } else result = text(a.deadline, b.deadline);
    }
    return result * direction || text(a.title, b.title);
  });
}
export function filterEntries(entries, { query = '', kind = '', country = '', status = '', recordKind = '', review = '', gap = '' } = {}, now = new Date()) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(e => (!recordKind || (e.record_kind || 'opportunity') === recordKind) && (!kind || entryCategories(e).includes(kind)) && (!country || e.country === country)
    && (!status || deadlineState(e, now) === status)
    && (!review || (review === 'verified' ? e.timeline?.status.startsWith('application_verified_') : review === 'pending' ? e.timeline && !e.timeline.status.startsWith('application_verified_') && !['not_accepting','discontinued','official_not_announced'].includes(e.timeline.status) : e.timeline?.status === review))
    && (!gap || Object.values(timingStatus(e)).some(item => item?.key === gap))
    && words.every(w => [e.title, e.country, entryTypes(e).join(' '), entryFunding(e).join(' '), e.note, e.source_url, e.timeline ? JSON.stringify(e.timeline) : ''].join(' ').toLocaleLowerCase().includes(w)));
}
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fundingBadge(entry) { return entryFunding(entry).map(label => `<small>资助：${escape(label)}</small>`).join(''); }
function verifiedText(e) {
  if (e.timeline) return `${timelineLabel(e)} · ${e.timeline.checked_on}；资助：${timingStatus(e).funding.label}`;
  if (e.record_kind === 'program') return `项目身份已核${e.verified_on ? ' · '+e.verified_on : ' · 核验日期未记'}；本轮招生另核`;
  return `${e.verification === 'live' ? '官网已复核' : '历史证据'} ${e.verified_on}${e.verification === 'live' ? '' : ' · 当前状态待核实'}`;
}
function timelineDetails(e) {
  const t = e.timeline;
  if (!t) return `<small>${escape(e.note)}</small>`;
  const link = url => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">官方依据 ↗</a>`;
  return `<p>${escape(t.intake_label)}</p><p><strong>${escape(timelineLabel(e))}</strong></p>`
    + (t.events.length ? `<ul class="timeline-events">${t.events.map(v => `<li><strong>${escape(EVENT_LABELS[v.kind])} · ${escape(v.date || v.time_text || '日期未公布')}${v.is_historical ? '（历史轮次）' : ''}</strong><small>${escape(v.scope)}${v.date && v.time_text ? ' · '+escape(v.time_text) : ''}${v.timezone ? ' · '+escape(sourceZoneLabel(v)) : ''} · ${link(v.source_url)}</small></li>`).join('')}</ul>` : '')
    + t.rules.map(r => `<p>${escape(r.text)} ${link(r.source_url)}</p>`).join('')
    + `<p><strong>资助：${escape(timingStatus(e).funding.label)}</strong> · ${escape(t.funding_timeline.note || '尚未核实单独资助日程。')} ${t.funding_timeline.source_urls.map(link).join(' ')}</p>`
    + (t.gaps.length ? `<p><strong>尚待确认</strong>${t.gaps.map(escape).join('；')}</p>` : '');
}
if (typeof document !== 'undefined') {
  const $ = s => document.querySelector(s);
  let entries = [], month = new Date().getMonth(), year = new Date().getFullYear(), selectedDay = '', sortKey = 'countdown', direction = 1;
  const filters = () => ({ query: $('#calendar-search').value, kind: $('#kind-filter').value, country: $('#country-filter').value, status: $('#status-filter').value, recordKind: $('#record-filter').value, review: $('#review-filter').value, gap: $('#gap-filter').value });
  function render() {
    const expanded = new Set([...document.querySelectorAll('#calendar-rows tr')].filter(row => row.querySelector('details[open]')).map(row => row.dataset.entry));
    const active = document.activeElement, activeRow = active?.closest('#calendar-rows tr');
    const focusRow = activeRow?.dataset.entry, focusIndex = activeRow ? [...activeRow.querySelectorAll('a, summary')].indexOf(active) : -1;
    const focusDay = active?.closest('[data-day]')?.dataset.day;
    const now = new Date(), selection = filters();
    const scoped = filterEntries(entries.map(e => displayEntry(e, now, selection.status)), { ...selection, status: '' }, now);
    const filtered = filterEntries(scoped, { status: selection.status }, now), sorted = sortEntries(filtered, sortKey, direction, now);
    const visibleEvents = scoped.flatMap(e => e.timeline ? timelineEvents(e) : e.deadline ? [e] : []).filter(e => !selection.status || deadlineState(e, now) === selection.status);
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    $('#month-title').textContent = `${year} 年 ${month + 1} 月`;
    const first = (new Date(year, month, 1).getDay() + 6) % 7, count = new Date(year, month + 1, 0).getDate();
    let grid = Array(first).fill('<div class="calendar-day is-blank" aria-hidden="true"></div>');
    const localToday = dateInZone(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (let day = 1; day <= count; day++) {
      const date = `${prefix}-${String(day).padStart(2, '0')}`, events = visibleEvents.filter(e => e.deadline === date);
      const classes = `calendar-day${events.length ? ' has-events' : ''}${date === localToday ? ' is-today' : ''}`;
      const content = `<span>${day}</span>${events.length ? `<span class="day-event">${events.length} 个<span class="day-label">节点</span></span>` : ''}`;
      grid.push(events.length ? `<button type="button" class="${classes}" data-day="${date}" aria-pressed="${date === selectedDay}" aria-label="${date}，${events.length} 个截止节点">${content}</button>` : `<div class="${classes}">${content}</div>`);
    }
    while (grid.length % 7) grid.push('<div class="calendar-day is-blank" aria-hidden="true"></div>');
    $('#month-grid').innerHTML = grid.join('');
    const agenda = selectedDay ? visibleEvents.filter(e => e.deadline === selectedDay) : sortEntries(visibleEvents.filter(e => deadlineState(e, now) === 'upcoming'), 'countdown', 1, now).slice(0, 5);
    $('#agenda-title').textContent = selectedDay ? `${selectedDay} 截止` : '最近截止';
    $('#agenda-reset').hidden = !selectedDay;
    $('#deadline-agenda').innerHTML = agenda.length ? agenda.map(e => `<article class="agenda-card"><p class="agenda-date">${escape(e.deadline)} · ${escape(countdown(e, now))}</p><h3><a href="${escape(e.source_url)}" target="_blank" rel="noopener noreferrer">${escape(e.title)}</a></h3>${fundingBadge(e)}<p class="calendar-muted">${escape(e.country)} · ${escape(entryTypes(e).join(' / '))}</p><p class="calendar-muted">${escape(verifiedText(e))}</p><p class="calendar-muted">${escape(e.date_note)} ${escape(e.note)}</p></article>`).join('') : '<p class="calendar-muted">当前筛选下没有已知的近期截止日期。无确定日期的机会仍可在下表查看。</p>';
    $('#result-count').textContent = `显示 ${filtered.length} / ${entries.length} 项 · ${filtered.filter(e => !e.deadline).length} 项无确定日期`;
    $('#calendar-empty').hidden = filtered.length > 0;
    $('#calendar-rows').innerHTML = sorted.map(e => `<tr data-entry="${escape(e.id)}"${selectedDay && (selectedDay === e.deadline || timelineEvents(e).some(v => v.deadline === selectedDay)) ? ' class="is-highlighted"' : ''}><td><strong><a href="${escape(e.source_url)}" target="_blank" rel="noopener noreferrer">${escape(e.title)}</a></strong>${fundingBadge(e)}<small>${e.record_kind === 'program' ? '长期学位项目' : '具体轮次／岗位'} · ${e.relation === 'game' ? '游戏相关' : e.relation === 'catalog' ? '目录内已核项目' : '相邻方向'}</small><div class="mobile-timing">${statusSummary(e)}</div><details><summary>${e.timeline ? '时间线与申请说明' : '申请说明'}</summary>${timelineDetails(e)}</details></td><td class="calendar-status">${statusSummary(e)}</td><td>${entryTypes(e).map(t => `<span class="calendar-tag">${escape(t)}</span>`).join('')}</td><td>${escape(e.country)}</td><td>${escape(e.deadline || timelineLabel(e) || (e.timing === 'annual' ? '年度轮次参考' : e.timing === 'rolling' ? '滚动招募' : '截止日期未核实'))}<small>${escape(e.timeline && !e.deadline ? e.timeline.intake_label : e.date_note)}</small>${e.deadline ? `<small>${escape(sourceZoneLabel(e) || '时区未注明，倒计时按 UTC 日期粗估')}</small>` : ''}</td><td>${escape(countdown(e, now))}</td><td><a href="${escape(e.source_url)}" target="_blank" rel="noopener noreferrer">查看官方来源 ↗</a><small>${escape(verifiedText(e))}</small></td></tr>`).join('');
    document.querySelectorAll('#calendar-rows tr').forEach(row => {
      if (expanded.has(row.dataset.entry)) row.querySelector('details').open = true;
      if (row.dataset.entry === focusRow && focusIndex >= 0) row.querySelectorAll('a, summary')[focusIndex]?.focus({ preventScroll: true });
    });
    if (focusDay) [...document.querySelectorAll('[data-day]')].find(button => button.dataset.day === focusDay)?.focus({ preventScroll: true });
    document.querySelectorAll('th[data-sort]').forEach(th => th.setAttribute('aria-sort', th.dataset.sort === sortKey ? direction === 1 ? 'ascending' : 'descending' : 'none'));
  }
  $('#month-grid').addEventListener('click', event => { const button = event.target.closest('[data-day]'); if (button) { selectedDay = selectedDay === button.dataset.day ? '' : button.dataset.day; render(); } });
  for (const [id, offset] of [['month-prev', -1], ['month-next', 1]]) $(`#${id}`).addEventListener('click', () => { const date = new Date(year, month + offset, 1); year = date.getFullYear(); month = date.getMonth(); selectedDay = ''; render(); });
  $('#month-today').addEventListener('click', () => { const today = new Date(); year = today.getFullYear(); month = today.getMonth(); selectedDay = ''; render(); });
  $('#agenda-reset').addEventListener('click', () => { selectedDay = ''; render(); });
  for (const id of ['calendar-search', 'kind-filter', 'country-filter', 'status-filter', 'record-filter', 'review-filter', 'gap-filter']) $(`#${id}`).addEventListener(id === 'calendar-search' ? 'input' : 'change', () => { selectedDay = ''; render(); });
  $('#clear-filters').addEventListener('click', () => { for (const id of ['calendar-search', 'kind-filter', 'country-filter', 'status-filter', 'record-filter', 'review-filter', 'gap-filter']) $(`#${id}`).value = ''; selectedDay = ''; render(); });
  $('#calendar-sort').addEventListener('change', () => { const [key, order] = $('#calendar-sort').value.split('-'); sortKey = key; direction = order === 'desc' ? -1 : 1; render(); });
  document.querySelectorAll('th[data-sort] button').forEach(button => button.addEventListener('click', () => { const key = button.parentElement.dataset.sort; direction = key === sortKey ? -direction : 1; sortKey = key; const value = ['name', 'date'].includes(key) ? `${key}-${direction === 1 ? 'asc' : 'desc'}` : key; $('#calendar-sort').value = direction === -1 && !['name', 'date'].includes(key) ? `${key}-desc` : value; render(); }));
  fetch('application-calendar.json', { cache: 'no-cache' }).then(response => { if (!response.ok) throw new Error('公开数据读取失败'); return response.json(); }).then(data => {
    if (data.schema !== 'gpa-application-calendar/v1' || !Array.isArray(data.entries)) throw new Error('公开数据格式不正确');
    entries = data.entries;
    for (const country of [...new Set(entries.map(e => e.country))].sort((a, b) => a.localeCompare(b, 'zh-CN'))) { const option = document.createElement('option'); option.value = country; option.textContent = country; $('#country-filter').append(option); }
    const syncNote = data.sync_summary ? ` · 来自机会雷达同步，另有 ${data.sync_summary.pending_cycles} 条线索待核实、尚未公开` : '';
    const coverage = data.catalog_coverage;
    $('#coverage-note').textContent = coverage ? `完整列出 ${coverage.phd} 个博士项目、${coverage.master} 个硕士项目；另有 ${coverage.opportunities} 条具体申请轮次、奖学金或岗位。轮次可能属于已有项目，不计作新的学位项目。` : '';
    const timelineRows = entries.filter(e => e.timeline);
    if (timelineRows.length) {
      const verified = timelineRows.filter(e => e.timeline.status.startsWith('application_verified_')).length;
      $('#timeline-note').textContent = `${timelineRows.length} 个项目已有逐项核查记录，其中 ${verified} 个核到具体日期或申请规则；其余查看各项的待公布、停招、冲突或未核实说明。申请与资助分别标注，核到规则不代表所有节点齐全。`;
    }
    $('#snapshot-note').textContent = `整理于 ${data.updated_on} · ${entries.length} 条公开项目与机会记录 · 各条目分别标注核查日期；读取失败时保留历史证据。${syncNote}`;
    render();
    setInterval(render, 60000);
  }).catch(error => { $('#snapshot-note').textContent = `${error.message}，请刷新重试。当前没有成功加载数据，不能视为没有机会。`; });
}
