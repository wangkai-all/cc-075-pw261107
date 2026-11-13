import { loadDataset } from './data.js';
import { TEST_CATALOG } from './catalog.js';
import { DEFAULT_SHIFTS, SHIFT_ORDER, fmtDuration, fmtTime, fmtDate, resolveShift } from './shift.js';
import {
  analyze,
  analyzeSummaryForTest,
  previewRuleChange,
  buildRuleset,
  defaultRulesFor,
  STAGES,
  TOTAL_STAGE,
  timelineFor
} from './analytics.js';
import { renderStageDistributions, renderShiftDayStrip } from './charts.js';
import { renderShiftStages, renderDepartmentBars, specimenTimeline, stageMeters } from './detail-charts.js';

const STAGE_RAMP = ['var(--stage-1)', 'var(--stage-2)', 'var(--stage-3)'];
const SHIFT_LABEL = Object.fromEntries(DEFAULT_SHIFTS.map(s => [s.id, s.name]));
const REASON_TEXT = {
  cancelled: '取消',
  recollect: '重采（默认排除）',
  invalid: '待核对',
  pause: '设备停机受影响（按规则排除）',
  outlier: '超限排除'
};

const state = {
  dataset: null,
  filters: {
    testId: 'cbc',
    dateFrom: null,
    dateTo: null,
    department: 'all',
    shift: 'all'
  },
  applied: null,
  drafts: {},
  tab: 'overdue',
  search: '',
  sort: 'slow',
  limit: 20,
  reviewLimit: 8,
  expanded: new Set(),
  reviewExpanded: new Set(),
  appliedAt: {}
};

let current = null;

const $ = id => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k in node && typeof v !== 'string') {
      node[k] = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function pct(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function signed(v, suffix = '') {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = n > 0 ? '+' : n < 0 ? '' : '';
  return `${s}${n}${suffix}`;
}

function deltaClass(v, lowerIsBetter = true) {
  if (v == null || !Number.isFinite(v) || v === 0) return 'delta-flat';
  const good = lowerIsBetter ? v < 0 : v > 0;
  return good ? 'delta-down' : 'delta-up';
}

function deltaTextDuration(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '无变化';
  return `${v > 0 ? '变慢' : '变快'} ${fmtDuration(Math.abs(v))}`;
}

function formatCount(n) {
  return `${n} 例`;
}

function shiftChip(shiftId, businessDay) {
  if (!shiftId) return '—';
  const label = SHIFT_LABEL[shiftId];
  // 夜班采样时刻在 00:00–08:00，归属前一日业务日：标签里带上业务日避免误读
  if (shiftId === 'night' && businessDay) return `${label} · 归 ${businessDay.slice(5)}`;
  return label;
}

// ---------- 初始化 ----------

async function boot() {
  try {
    state.dataset = await loadDataset();
  } catch (err) {
    document.querySelector('main').innerHTML =
      `<div class="card"><p class="card-title">数据未能加载</p><p class="card-sub">${err.message}。请通过本地 HTTP 服务打开页面（例如 <code>node scripts/serve.mjs</code>），不要直接双击 HTML 文件。</p></div>`;
    return;
  }

  const bounds = businessDayBounds(state.dataset);
  state.filters.dateFrom = bounds.from;
  state.filters.dateTo = bounds.to;
  state.applied = buildRuleset(TEST_CATALOG);

  populateControls(bounds);
  bindControls();
  restoreTheme();
  renderAll();
}

function businessDayBounds(dataset) {
  const days = dataset.specimens
    .filter(s => s.collectedAt != null)
    .map(s => resolveShift(s.collectedAt).businessDay)
    .sort();
  return { from: days[0], to: days[days.length - 1] };
}

function populateControls(bounds) {
  const testSel = $('test-select');
  clearNode(testSel);
  for (const t of TEST_CATALOG) {
    testSel.appendChild(el('option', { value: t.id, text: `${t.name}（${t.code}）` }));
  }
  testSel.value = state.filters.testId;

  const deptSel = $('dept-select');
  clearNode(deptSel);
  deptSel.appendChild(el('option', { value: 'all', text: '全部科室' }));
  for (const d of state.dataset.departments) {
    deptSel.appendChild(el('option', { value: d, text: d }));
  }

  $('date-from').value = bounds.from;
  $('date-to').value = bounds.to;
  $('date-from').min = bounds.from;
  $('date-from').max = bounds.to;
  $('date-to').min = bounds.from;
  $('date-to').max = bounds.to;

  renderDatePresets(bounds);
  $('data-meta').textContent =
    `数据 ${state.dataset.meta.dateRange.from} → ${state.dataset.meta.dateRange.to} · 虚构生成 ${state.dataset.meta.generatedOn} · ${state.dataset.specimens.length} 份标本`;
}

function renderDatePresets(bounds) {
  const wrap = $('date-presets');
  clearNode(wrap);
  const maxDate = new Date(bounds.to + 'T00:00:00Z');
  const presets = [
    {
      id: 'all',
      label: '全部',
      from: bounds.from,
      to: bounds.to
    },
    { id: '7d', label: '近 7 天', days: 7 },
    { id: '14d', label: '近 14 天', days: 14 },
    { id: '30d', label: '近 30 天', days: 30 }
  ];

  for (const p of presets) {
    let from = p.from;
    let to = p.to;
    if (p.days) {
      to = bounds.to;
      from = fmtDate(maxDate.getTime() - (p.days - 1) * 86400000);
      if (from < bounds.from) from = bounds.from;
    }
    const btn = el('button', {
      type: 'button',
      class: 'chip',
      text: p.label,
      'aria-pressed': state.filters.dateFrom === from && state.filters.dateTo === to ? 'true' : 'false'
    });
    btn.addEventListener('click', () => {
      state.filters.dateFrom = from;
      state.filters.dateTo = to;
      $('date-from').value = from;
      $('date-to').value = to;
      renderDatePresets(bounds);
      resetListState();
      renderAll();
    });
    wrap.appendChild(btn);
  }
}

function bindControls() {
  $('test-select').addEventListener('change', e => {
    state.filters.testId = e.target.value;
    resetListState();
    renderAll();
  });
  $('dept-select').addEventListener('change', e => {
    state.filters.department = e.target.value;
    resetListState();
    renderAll();
  });
  $('shift-select').addEventListener('change', e => {
    state.filters.shift = e.target.value;
    resetListState();
    renderAll();
  });
  $('date-from').addEventListener('change', e => {
    if (!e.target.value) return;
    state.filters.dateFrom = e.target.value;
    if (state.filters.dateFrom > state.filters.dateTo) {
      state.filters.dateTo = state.filters.dateFrom;
      $('date-to').value = state.filters.dateTo;
    }
    resetListState();
    renderAll();
  });
  $('date-to').addEventListener('change', e => {
    if (!e.target.value) return;
    state.filters.dateTo = e.target.value;
    if (state.filters.dateTo < state.filters.dateFrom) {
      state.filters.dateFrom = state.filters.dateTo;
      $('date-from').value = state.filters.dateFrom;
    }
    resetListState();
    renderAll();
  });

  $('spec-search').addEventListener('input', e => {
    state.search = e.target.value.trim().toLowerCase();
    state.limit = 20;
    renderSpecimens();
  });
  $('spec-sort').addEventListener('change', e => {
    state.sort = e.target.value;
    renderSpecimens();
  });
  $('spec-more').addEventListener('click', () => {
    state.limit += 20;
    renderSpecimens(false);
  });
  $('review-more')?.addEventListener('click', () => {
    state.reviewLimit += 8;
    renderReview(current);
  });

  for (const btn of document.querySelectorAll('[data-table-toggle]')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tableToggle;
      const table = $(`${key}-table`);
      const chart = $(`${key}-chart`);
      const showTable = table.classList.contains('hidden');
      table.classList.toggle('hidden', !showTable);
      if (chart) chart.classList.toggle('hidden', showTable);
      btn.textContent = showTable ? '图表' : '数据表';
      btn.setAttribute('aria-expanded', showTable ? 'true' : 'false');
    });
  }

  $('apply-rules').addEventListener('click', applyDraftRules);
  $('reset-rules').addEventListener('click', resetDraftRules);
  $('theme-toggle').addEventListener('click', toggleTheme);

  document.querySelector('main').addEventListener('click', e => {
    const more = e.target.closest('#review-more');
    if (more) {
      state.reviewLimit += 8;
      renderReview(current);
    }
  });
}

function resetListState() {
  state.tab = 'overdue';
  state.limit = 20;
  state.reviewLimit = 8;
  state.search = '';
  $('spec-search').value = '';
  state.expanded.clear();
  state.reviewExpanded.clear();
}

// ---------- 渲染总入口 ----------

function renderAll() {
  const rule = state.applied[state.filters.testId];
  current = analyze(state.dataset, state.filters, state.applied, TEST_CATALOG);
  renderScope(current);
  renderHero(current, rule);
  renderKpis(current, rule);
  renderStages(current, rule);
  renderShiftBlock(current, rule);
  renderDepartments(current, rule);
  renderProjectTable();
  renderSpecimens(true);
  renderEvents(current, rule);
  renderReview(current);
  renderRulesForm(current, rule);
  renderPreview();
}

function renderScope(result) {
  const dept = state.filters.department === 'all' ? '全部科室' : state.filters.department;
  const shift = state.filters.shift === 'all' ? '全部班次' : SHIFT_LABEL[state.filters.shift];
  const note = $('scope-note');
  clearNode(note);
  note.append(
    el('strong', { text: `${result.test.name} · ${dept} · ${shift}` }),
    document.createTextNode(
      `　业务日 ${state.filters.dateFrom} → ${state.filters.dateTo}｜夜班归前一日`
    )
  );
}

function renderHero(result, rule) {
  const t = result.totals;
  const status = $('hero-status');
  const heroValue = $('hero-value');
  clearNode(heroValue);
  if (t.median == null) {
    heroValue.textContent = '—';
  } else {
    const d = Math.floor(t.median / 60);
    const m = Math.round(t.median % 60);
    if (d > 0) {
      heroValue.append(document.createTextNode(String(d)), el('small', { text: '小时' }));
      if (m > 0) heroValue.append(document.createTextNode(String(m)), el('small', { text: '分' }));
    } else {
      heroValue.append(document.createTextNode(String(m)), el('small', { text: '分' }));
    }
  }

  const over = t.median != null && rule.targets.total != null && t.median > rule.targets.total;
  status.className = `status-badge ${over ? 'bad' : 'good'}`;
  status.textContent = over ? '中位超目标' : '中位在目标内';

  const target = $('hero-target');
  clearNode(target);
  if (rule.targets.total != null && t.median != null) {
    const diff = t.median - rule.targets.total;
    target.append(
      el('span', { text: `目标 ${fmtDuration(rule.targets.total)}` }),
      el('span', {
        class: 'tag',
        text: diff > 0 ? `比目标慢 ${fmtDuration(diff)}` : diff < 0 ? `比目标快 ${fmtDuration(-diff)}` : '与目标持平'
      }),
      el('span', { class: 'tag', text: `患者口径中位 ${fmtDuration(t.patientMedian)}` })
    );
  } else {
    target.append(el('span', { text: '端到端目标未设置' }));
  }

  const foot = $('hero-foot');
  clearNode(foot);
  const items = [
    ['纳入标本', `${t.included} 例`],
    ['独立患者', `${t.patients} 例`],
    ['P90', fmtDuration(t.p90)],
    ['超时', `${t.overdue} 例（${pct(t.overdueRate)}）`],
    ['待核对', `${t.pending} 例`]
  ];
  for (const [label, value] of items) {
    const block = el('span', {}, [
      el('span', { text: `${label} ` }),
      el('strong', { text: value })
    ]);
    foot.appendChild(block);
  }
}

function renderKpis(result, rule) {
  const t = result.totals;
  const wrap = $('kpi-grid');
  clearNode(wrap);
  const items = [
    {
      label: '独立患者',
      value: `${t.patients}`,
      unit: '例',
      note: `纳入标本 ${t.included} 例，同一患者多次采样合并`
    },
    {
      label: '超时率',
      value: pct(t.overdueRate, 1),
      note: `${t.overdue} 例超过端到端目标`
    },
    {
      label: '待核对',
      value: `${t.pending}`,
      unit: '例',
      note: '缺失或顺序异常，不进均值',
      warn: t.pending > 0
    },
    {
      label: '复测轮次',
      value: `${t.retestRuns}`,
      unit: '次',
      note: `涉及 ${t.retestSpecimens} 份标本，不重复计患者`
    },
    {
      label: '重采标本',
      value: `${t.recollect}`,
      unit: '例',
      note: rule.includeRecollect ? '当前规则已计入均值' : '默认排除出均值'
    },
    {
      label: '取消标本',
      value: `${t.cancelled}`,
      unit: '例',
      note: '不计入周转统计'
    }
  ];
  for (const item of items) {
    const stat = el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: item.label }),
      el('div', { class: 'stat-value' }, [
        document.createTextNode(item.value),
        item.unit ? el('small', { text: item.unit }) : null
      ]),
      el('div', { class: `stat-note${item.warn ? ' warn' : ''}`, text: item.note })
    ]);
    wrap.appendChild(stat);
  }
}

function renderStages(result, rule) {
  const stages = STAGES.map((st, i) => ({
    key: st.key,
    label: st.label,
    color: STAGE_RAMP[i],
    stats: result.stageStats[st.key],
    target: rule.targets[st.key],
    overCount: result.stageOverTarget[st.key]
  }));
  // 总周转作为第四段展示
  stages.push({
    key: 'total',
    label: '总周转（采样→结果）',
    color: 'var(--stage-4)',
    stats: result.stageStats.total,
    target: rule.targets.total,
    overCount: result.stageOverTarget.total
  });

  renderStageDistributions($('stage-chart'), stages, {
    onHover: stage => ({
      title: stage.label,
      rows: [
        { label: '中位', value: fmtDuration(stage.stats.median), color: stage.color },
        { label: 'P10–P90', value: `${fmtDuration(stage.stats.p10)} – ${fmtDuration(stage.stats.p90)}` },
        { label: '均值', value: fmtDuration(stage.stats.mean) },
        { label: '样本', value: `${stage.stats.n} 例` },
        { label: '目标', value: stage.target == null ? '未设置' : fmtDuration(stage.target) },
        { label: '超时', value: stage.overCount == null ? '—' : `${stage.overCount} 例` }
      ]
    })
  });

  $('stage-sub').textContent =
    `${result.test.name} · 纳入 ${result.totals.included} 例 · 中位、P10–P90 与目标线；待核对记录不参与计算。`;

  const meta = $('stage-meta');
  clearNode(meta);
  const legend = [
    ['var(--stage-2)', 'P10–P90 区间'],
    ['var(--ink)', '中位'],
    ['var(--ink-3)', '目标']
  ];
  for (const [color, label] of legend) {
    const item = el('span', { class: 'legend-item' });
    const sw = el('span', { class: 'legend-swatch' });
    sw.style.background = color;
    if (label === '中位') {
      sw.style.height = '2px';
      sw.style.width = '14px';
    } else if (label === '目标') {
      sw.style.width = '2px';
      sw.style.height = '12px';
    }
    item.append(sw, document.createTextNode(label));
    meta.appendChild(item);
  }
  meta.appendChild(el('span', { class: 'muted', text: '各阶段独立刻度，不拼成一条总时间轴。' }));

  renderStageTable(result, rule, stages);
}

function renderStageTable(result, rule, stages) {
  const wrap = $('stage-table');
  clearNode(wrap);
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '阶段' }),
        el('th', { scope: 'col', class: 'num', text: 'n' }),
        el('th', { scope: 'col', class: 'num', text: '中位' }),
        el('th', { scope: 'col', class: 'num', text: 'P90' }),
        el('th', { scope: 'col', class: 'num', text: '均值' }),
        el('th', { scope: 'col', class: 'num', text: '目标' }),
        el('th', { scope: 'col', class: 'num', text: '超时' }),
        el('th', { scope: 'col', class: 'num', text: '超时率' })
      ])
    ]),
    el('tbody', {}, stages.map(st => {
      const s = st.stats;
      const overPct = s.n && st.overCount != null ? st.overCount / s.n : null;
      return el('tr', {}, [
        el('td', {}, [
          el('span', { class: 'legend-swatch', style: { background: st.color, width: '10px', height: '10px', display: 'inline-block', marginRight: '7px' } }),
          document.createTextNode(st.label)
        ]),
        el('td', { class: 'num', text: String(s.n) }),
        el('td', { class: 'num', text: fmtDuration(s.median) }),
        el('td', { class: 'num', text: fmtDuration(s.p90) }),
        el('td', { class: 'num', text: fmtDuration(s.mean) }),
        el('td', { class: 'num', text: st.target == null ? '—' : fmtDuration(st.target) }),
        el('td', { class: 'num', text: st.overCount == null ? '—' : String(st.overCount) }),
        el('td', { class: 'num', text: overPct == null ? '—' : pct(overPct, 1) })
      ]);
    }))
  ]);
  wrap.appendChild(table);
  wrap.appendChild(el('p', {
    class: 'table-note',
    text: '均值受长尾影响较大，判断常态请优先看中位与 P90；超时按当前项目规则计算。'
  }));
}

function renderShiftBlock(result, rule) {
  renderShiftStages($('shift-chart'), result.shifts, result.stageStats, rule);
  renderShiftDayStrip($('shift-strip'));

  const wrap = $('shift-summary');
  clearNode(wrap);
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '班次' }),
        el('th', { scope: 'col', class: 'num', text: 'n' }),
        el('th', { scope: 'col', class: 'num', text: '中位总周转' }),
        el('th', { scope: 'col', class: 'num', text: '超时' }),
        el('th', { scope: 'col', class: 'num', text: '待核对' })
      ])
    ]),
    el('tbody', {}, result.shifts.map(s => el('tr', {}, [
      el('td', {}, [
        el('span', { class: 'legend-swatch', style: { background: shiftColor(s.id), width: '10px', height: '10px', display: 'inline-block', marginRight: '7px' } }),
        document.createTextNode(s.name)
      ]),
      el('td', { class: 'num', text: String(s.n) }),
      el('td', { class: 'num', text: fmtDuration(s.medianTotal) }),
      el('td', { class: 'num', text: `${s.overdue}（${pct(s.overdueRate)}）` }),
      el('td', { class: 'num', text: String(s.pending) })
    ])))
  ]);
  wrap.appendChild(table);
  wrap.appendChild(el('p', {
    class: 'table-note',
    text: '夜班按采样时刻归到前一业务日；跨 00:00 的样本不会被拆成两个班次。班次内不足 5 例时中位仅供参考。'
  }));

  const shiftWrap = $('shift-table');
  clearNode(shiftWrap);
  const headers = ['班次', ...STAGES.map(s => s.shortLabel), '总周转', 'n', '超时率'];
  const stageTable = el('table', {}, [
    el('thead', {}, [el('tr', {}, headers.map((h, i) => el('th', { scope: 'col', class: i === 0 ? '' : 'num', text: h })))]),
    el('tbody', {}, result.shifts.map(s => el('tr', {}, [
      el('td', { text: s.name }),
      ...STAGES.map(st => el('td', { class: 'num', text: fmtDuration(s.stages[st.key].median) })),
      el('td', { class: 'num', text: fmtDuration(s.stages.total.median) }),
      el('td', { class: 'num', text: String(s.n) }),
      el('td', { class: 'num', text: pct(s.overdueRate, 1) })
    ])))
  ]);
  shiftWrap.appendChild(stageTable);
}

function shiftColor(id) {
  return `var(--series-${{ morning: 1, evening: 2, night: 3 }[id] || 1})`;
}

function renderDepartments(result, rule) {
  renderDepartmentBars($('dept-chart'), result.departments, rule);
  $('dept-sub').textContent =
    `同一项目内按科室比较中位总周转；超时率按端到端目标 ${fmtDuration(rule.targets.total) || '未设置'}。`;

  const wrap = $('dept-table');
  clearNode(wrap);
  const rows = [...result.departments].filter(d => d.n > 0).sort((a, b) => (b.medianTotal ?? 0) - (a.medianTotal ?? 0));
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: '科室' }),
      el('th', { scope: 'col', class: 'num', text: 'n' }),
      el('th', { scope: 'col', class: 'num', text: '中位总周转' }),
      el('th', { scope: 'col', class: 'num', text: '超时率' }),
      el('th', { scope: 'col', class: 'num', text: '待核对' })
    ])]),
    el('tbody', {}, rows.map(d => el('tr', {}, [
      el('td', { text: d.name }),
      el('td', { class: 'num', text: String(d.n) }),
      el('td', { class: 'num', text: fmtDuration(d.medianTotal) }),
      el('td', { class: 'num', text: pct(d.overdueRate, 1) }),
      el('td', { class: 'num', text: String(d.pending) })
    ])))
  ]);
  wrap.appendChild(table);
}

function renderProjectTable() {
  const wrap = $('project-table');
  clearNode(wrap);
  const summaries = TEST_CATALOG.map(t =>
    analyzeSummaryForTest(state.dataset, state.filters, state.applied, TEST_CATALOG, t.id)
  );
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: '项目' }),
      el('th', { scope: 'col', class: 'num', text: '标本' }),
      el('th', { scope: 'col', class: 'num', text: '独立患者' }),
      el('th', { scope: 'col', class: 'num', text: '中位' }),
      el('th', { scope: 'col', class: 'num', text: '目标' }),
      el('th', { scope: 'col', class: 'num', text: '超时率' }),
      el('th', { scope: 'col', class: 'num', text: '待核对' })
    ])]),
    el('tbody', {}, summaries.map(s => {
      const isCurrent = s.testId === state.filters.testId;
      return el('tr', {}, [
        el('td', {}, [
          document.createTextNode(s.test.name),
          isCurrent ? el('span', { class: 'tag retest', text: '当前', style: { marginLeft: '6px' } }) : null
        ]),
        el('td', { class: 'num', text: String(s.totals.included) }),
        el('td', { class: 'num', text: String(s.totals.patients) }),
        el('td', { class: 'num', text: fmtDuration(s.totals.median) }),
        el('td', { class: 'num', text: s.rule.targets.total == null ? '—' : fmtDuration(s.rule.targets.total) }),
        el('td', { class: 'num', text: pct(s.totals.overdueRate, 1) }),
        el('td', { class: 'num', text: String(s.totals.pending) })
      ]);
    }))
  ]);
  wrap.appendChild(table);
  wrap.appendChild(el('p', {
    class: 'table-note',
    text: '各项目按自己的目标与排除规则评估；此处共享同一日期、科室与班次筛选。'
  }));
}

// ---------- 样本表 ----------

const TABS = [
  { id: 'overdue', label: '超时样本' },
  { id: 'included', label: '已纳入' },
  { id: 'pause', label: '停机受影响' },
  { id: 'retest', label: '有复测' },
  { id: 'recollect', label: '重采' },
  { id: 'excluded', label: '已排除' }
];

function tabEntries(result) {
  switch (state.tab) {
    case 'overdue': return result.overdueList;
    case 'included': return result.included;
    case 'pause': return result.pauseAffected;
    case 'retest': return result.observations.filter(o => o.retestRuns.length > 0);
    case 'recollect': return result.recollectSpecimens;
    case 'excluded': return result.observations.filter(o => o.excludedReason);
    default: return result.included;
  }
}

function renderSpecimens(resetLimit = false) {
  if (resetLimit) state.limit = 20;
  const rule = state.applied[state.filters.testId];
  const result = current;

  const tabsWrap = $('spec-tabs');
  clearNode(tabsWrap);
  const counts = {
    overdue: result.overdueList.length,
    included: result.included.length,
    pause: result.pauseAffected.length,
    retest: result.observations.filter(o => o.retestRuns.length > 0).length,
    recollect: result.recollectSpecimens.length,
    excluded: result.observations.filter(o => o.excludedReason).length
  };
  for (const tab of TABS) {
    const btn = el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': state.tab === tab.id ? 'true' : 'false',
      text: `${tab.label} ${counts[tab.id]}`
    });
    btn.addEventListener('click', () => {
      state.tab = tab.id;
      state.limit = 20;
      renderSpecimens();
    });
    tabsWrap.appendChild(btn);
  }

  let entries = tabEntries(result);
  if (state.search) {
    const q = state.search;
    entries = entries.filter(o =>
      o.specimenId.toLowerCase().includes(q) || o.patientKey.toLowerCase().includes(q)
    );
  }
  entries = [...entries];
  if (state.sort === 'slow') {
    entries.sort((a, b) => (b.effective?.total ?? b.raw?.total ?? -1) - (a.effective?.total ?? a.raw?.total ?? -1));
  } else if (state.sort === 'fast') {
    entries.sort((a, b) => (a.effective?.total ?? a.raw?.total ?? Infinity) - (b.effective?.total ?? b.raw?.total ?? Infinity));
  } else {
    entries.sort((a, b) => (b.collectedAt ?? 0) - (a.collectedAt ?? 0));
  }

  $('spec-count').textContent =
    `${TABS.find(t => t.id === state.tab).label} · ${entries.length} 例` +
    (state.tab === 'overdue' ? '（均已超过端到端目标）' : '');

  const body = $('spec-body');
  clearNode(body);
  const visible = entries.slice(0, state.limit);

  for (const obs of visible) {
    body.appendChild(specimenRow(obs, rule));
    if (state.expanded.has(obs.specimenId)) {
      const detail = el('tr', { class: 'detail-row' }, [
        el('td', { colspan: '10' }, [buildDetail(obs, rule)])
      ]);
      body.appendChild(detail);
    }
  }

  const more = $('spec-more');
  more.classList.toggle('hidden', entries.length <= state.limit);
  more.textContent = `显示更多（剩余 ${entries.length - state.limit} 例）`;

  const empty = $('spec-empty');
  clearNode(empty);
  if (!entries.length) {
    empty.appendChild(el('div', { class: 'chart-empty', text: '该筛选与分类下没有样本' }));
  }
}

function specimenRow(obs, rule) {
  const row = el('tr', {});
  const expandBtn = el('button', {
    type: 'button',
    class: 'row-toggle',
    'aria-expanded': state.expanded.has(obs.specimenId) ? 'true' : 'false',
    'aria-label': `${state.expanded.has(obs.specimenId) ? '收起' : '展开'}标本 ${obs.specimenId} 的关键时间点`,
    text: '›'
  });
  expandBtn.addEventListener('click', () => {
    if (state.expanded.has(obs.specimenId)) state.expanded.delete(obs.specimenId);
    else state.expanded.add(obs.specimenId);
    renderSpecimens();
  });
  cell(row, el('div', {}, [expandBtn]));

  cell(row, el('span', { class: 'mono', text: obs.specimenId, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '11.5px' } }));
  // 列是“采样时间”，必须显示真实时刻；业务日归属在班次标签与展开详情里说明
  cell(row, el('span', { text: fmtTime(obs.collectedAt, { withDate: true }) }));
  cell(row, el('span', { text: shiftChip(obs.shiftId, obs.businessDay) }));
  cell(row, el('span', { text: obs.department }));

  const over = obs.included && obs.effective.total != null && rule.targets.total != null && obs.effective.total > rule.targets.total;
  for (const st of STAGES) {
    const v = obs.effective?.[st.duration] ?? obs.raw[st.duration];
    const t = rule.targets[st.key];
    const isOver = v != null && t != null && v > t;
    cell(row, el('span', {
      class: 'num',
      text: fmtDuration(v),
      style: isOver ? { color: 'var(--critical)' } : null
    }), true);
  }
  const total = obs.effective?.total ?? obs.raw.total;
  cell(row, el('strong', {
    class: 'num',
    text: fmtDuration(total),
    style: over ? { color: 'var(--critical)' } : null
  }), true);

  const tags = el('div', { class: 'chiprow' });
  if (obs.cancelled) tags.appendChild(el('span', { class: 'tag', text: '取消' }));
  if (obs.runKind === 'recollect') tags.appendChild(el('span', { class: 'tag recollect', text: '重采' }));
  if (obs.retestRuns.length) tags.appendChild(el('span', { class: 'tag retest', text: `复测 ${obs.retestRuns.length}` }));
  if (obs.pauseAffected) tags.appendChild(el('span', { class: 'tag pause', text: '停机' }));
  if (obs.issues.length) tags.appendChild(el('span', { class: 'tag issue', text: '待核对' }));
  if (over) tags.appendChild(el('span', { class: 'tag over', text: '超时' }));
  if (obs.excludedReason && !obs.cancelled) {
    const reason = REASON_TEXT[obs.excludedReason];
    if (reason && !['重采（默认排除）', '待核对'].includes(reason)) {
      tags.appendChild(el('span', { class: 'tag', text: reason }));
    }
  }
  if (!tags.childNodes.length) tags.appendChild(el('span', { class: 'tag', text: '正常' }));
  cell(row, tags);
  return row;
}

function cell(row, content, numeric = false) {
  const td = el('td', { class: numeric ? 'num' : '' }, [content]);
  row.appendChild(td);
  return td;
}

function buildDetail(obs, rule) {
  const panel = el('div', { class: 'detail-panel' });
  const top = el('div', { class: 'detail-top' });
  top.append(
    el('span', { class: 'mono', text: obs.specimenId }),
    el('span', { class: 'tag', text: `患者 ${obs.patientKey}` }),
    el('span', { class: 'tag', text: `${obs.department} · ${shiftChip(obs.shiftId)}` }),
    obs.collectedAt != null ? el('span', { class: 'tag', text: `业务日 ${obs.businessDay}` }) : null,
    obs.cancelReason ? el('span', { class: 'tag', text: `取消原因：${obs.cancelReason}` }) : null,
    obs.excludedReason ? el('span', { class: 'tag issue', text: `统计口径：${REASON_TEXT[obs.excludedReason]}` }) : null,
    obs.runKind === 'recollect'
      ? el('span', { class: 'tag recollect', text: `重采自 ${obs.recollectOf}` })
      : null
  );
  panel.appendChild(top);

  const issues = obs.issues;
  if (issues.length) {
    const list = el('div', { class: 'grid', style: { gap: '4px' } });
    for (const issue of issues) {
      list.appendChild(el('div', { class: 'review-issue', text: issue.message }));
    }
    panel.appendChild(list);
  }

  panel.appendChild(specimenTimeline(obs, rule, current.stageStats));
  panel.appendChild(stageMeters(obs, rule));

  if (obs.retestRuns.length) {
    const block = el('div', { class: 'retest-list' });
    block.appendChild(el('div', {
      class: 'timeline-note',
      text: `复测轮次按标本内事件统计，不单独计为患者。共 ${obs.retestRuns.length} 轮。`
    }));
    for (const run of obs.retestRuns) {
      const item = el('div', { class: 'retest-item' });
      item.append(
        el('span', { class: 'mono', text: run.runId }),
        el('span', { text: `${run.startedAt == null ? '开始缺失' : fmtTime(run.startedAt, { withDate: true })} → ${run.resultedAt == null ? '结果缺失' : fmtTime(run.resultedAt, { withDate: true })}` }),
        el('span', { text: `用时 ${fmtDuration(run.duration)}` }),
        run.issues.length
          ? el('span', { class: 'tag issue', text: run.issues[0].message })
          : el('span', { class: 'tag', text: '参与复测统计' })
      );
      block.appendChild(item);
    }
    panel.appendChild(block);
  }

  if (obs.pauseHits.length) {
    const block = el('div', { class: 'grid', style: { gap: '4px' } });
    for (const hit of obs.pauseHits) {
      block.appendChild(el('div', {
        class: 'timeline-note',
        text: `设备停机：${hit.device}（${hit.reason}）${fmtTime(hit.start, { withDate: true })} → ${fmtTime(hit.end)}，与等待窗口重叠 ${fmtDuration(hit.overlapMinutes)}。`
      }));
    }
    panel.appendChild(block);
  }

  return panel;
}

// ---------- 事件统计 ----------

function renderEvents(result, rule) {
  const t = result.totals;
  const grid = $('event-grid');
  clearNode(grid);

  const tiles = [
    {
      label: '复测轮次',
      value: `${t.retestRuns}`,
      unit: '次',
      note: `涉及 ${t.retestSpecimens} 份标本 · 同一标本不重复计患者`
    },
    {
      label: '重采标本',
      value: `${t.recollect}`,
      unit: '例',
      note: rule.includeRecollect ? '当前计入均值；同一患者仍只计 1 例' : '默认排除出均值；同一患者仍只计 1 例'
    },
    {
      label: '取消标本',
      value: `${t.cancelled}`,
      unit: '例',
      note: `占命中 ${pct(t.hit ? t.cancelled / t.hit : null, 1)} · 不计入周转`
    },
    {
      label: '停机受影响',
      value: `${t.pauseAffected}`,
      unit: '例',
      note: `与等待重叠合计 ${fmtDuration(t.pauseMinutes)} · ${
        { mark: '保留并标注', deduct: '已扣除', exclude: '已排除' }[rule.pausePolicy]
      }`
    }
  ];
  for (const tile of tiles) {
    grid.appendChild(el('div', { class: 'event-tile' }, [
      el('div', { class: 'et-label', text: tile.label }),
      el('div', { class: 'et-value' }, [document.createTextNode(tile.value), el('small', { text: tile.unit })]),
      el('div', { class: 'et-note', text: tile.note })
    ]));
  }

  const wrap = $('pause-table');
  clearNode(wrap);
  const pauses = state.dataset.devicePauses.filter(p => p.testIds.includes(state.filters.testId));
  if (!pauses.length) {
    wrap.appendChild(el('p', { class: 'table-note', text: '当前项目没有登记设备停机记录。' }));
    return;
  }

  const relevant = result.observations;
  const rows = pauses.map(p => {
    let affected = 0;
    let overlap = 0;
    for (const obs of relevant) {
      const hit = obs.pauseHits.find(h => h.id === p.id);
      if (hit) {
        affected += 1;
        overlap += hit.overlapMinutes;
      }
    }
    return { p, affected, overlap };
  });

  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: '设备' }),
      el('th', { scope: 'col', text: '停机窗口' }),
      el('th', { scope: 'col', text: '原因' }),
      el('th', { scope: 'col', class: 'num', text: '受影响标本' }),
      el('th', { scope: 'col', class: 'num', text: '重叠合计' })
    ])]),
    el('tbody', {}, rows.map(({ p, affected, overlap }) => el('tr', {}, [
      el('td', { text: p.device }),
      el('td', { text: `${fmtTime(p.start, { withDate: true })} → ${fmtTime(p.end, { withDate: true })}` }),
      el('td', { text: p.reason }),
      el('td', { class: 'num', text: `${affected}` }),
      el('td', { class: 'num', text: fmtDuration(overlap) })
    ])))
  ]);
  wrap.appendChild(table);

  const note = $('event-note');
  note.textContent =
    '口径说明：一名患者同一项目多次采样（复查）只计 1 例患者；复测是同一标本内的轮次，单独列次数；重采是新的标本，默认不进入均值且不重复计患者；取消标本与设备停机单独统计。';
}

// ---------- 待核对 ----------

function renderReview(result) {
  const wrap = $('review-list');
  clearNode(wrap);
  const obsMap = new Map(result.observations.map(o => [o.specimenId, o]));
  const list = result.review;
  $('review-count').textContent =
    list.length ? `待核对 ${list.length} 条` : '没有待核对记录';

  if (!list.length) {
    clearNode($('review-empty'));
    $('review-empty').appendChild(el('div', { class: 'chart-empty', text: '所有记录的关键时间点完整且顺序合理。' }));
    // 列表变空时同时移除残留的“显示更多”按钮
    $('review-more')?.remove();
    return;
  }
  clearNode($('review-empty'));

  for (const item of list.slice(0, state.reviewLimit)) {
    wrap.appendChild(reviewCard(item, obsMap, result));
  }

  let more = $('review-more');
  if (list.length > state.reviewLimit) {
    if (!more) {
      more = el('button', { class: 'load-more', id: 'review-more', type: 'button', text: `显示更多（剩余 ${list.length - state.reviewLimit} 条）` });
      wrap.parentElement.appendChild(more);
    } else {
      more.textContent = `显示更多（剩余 ${list.length - state.reviewLimit} 条）`;
    }
  } else if (more) {
    more.remove();
  }
}

function reviewCard(item, obsMap, result) {
  const card = el('div', { class: 'review-item' });
  const isRetest = item.type === 'retest';
  const obs = obsMap.get(item.specimenId);
  const evaluated = isRetest
    ? (obs?.retestRuns.find(r => r.runId === item.runId) ?? null)
    : obs;

  const head = el('div', { class: 'review-head' }, [
    el('span', { class: 'mono', text: item.entityId, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '11.5px' } }),
    el('span', { class: 'tag issue', text: item.typeLabel }),
    el('span', { text: `${item.department} · ${item.shiftName || shiftChip(item.shiftId)}` }),
    item.businessDay ? el('span', { text: `业务日 ${item.businessDay}` }) : null,
    el('span', { text: `患者 ${item.patientKey}` }),
    isRetest ? el('span', { text: `所属标本 ${item.specimenId}` }) : null
  ]);
  card.appendChild(head);

  const issues = el('div', { class: 'grid', style: { gap: '3px' } });
  for (const issue of item.issues) {
    issues.appendChild(el('div', { class: 'review-issue', text: `${issue.message}（${issue.code === 'missing' ? '缺少时间戳' : '顺序异常'}）` }));
  }
  card.appendChild(issues);

  const times = el('div', { class: 'timeline-times' });
  if (isRetest) {
    times.append(
      timeCell('复测开始', evaluated?.startedAt),
      timeCell('复测结果', evaluated?.resultedAt),
      timeCell('原采样', obs?.collectedAt),
      timeCell('原出结果', obs?.resultedAt)
    );
  } else if (obs) {
    times.append(
      timeCell('采样', obs.collectedAt),
      timeCell('接收', obs.receivedAt),
      timeCell('上机', obs.analyzedAt),
      timeCell('出结果', obs.resultedAt)
    );
  }
  card.appendChild(times);

  const expand = el('button', {
    class: 'row-toggle',
    type: 'button',
    'aria-expanded': state.reviewExpanded.has(item.entityId) ? 'true' : 'false',
    style: { width: 'auto', padding: '0 10px', height: '26px', fontSize: '12px' },
    text: state.reviewExpanded.has(item.entityId) ? '收起点位' : '展开关键时间点'
  });
  expand.addEventListener('click', () => {
    if (state.reviewExpanded.has(item.entityId)) state.reviewExpanded.delete(item.entityId);
    else state.reviewExpanded.add(item.entityId);
    renderReview(current);
  });
  card.appendChild(expand);

  if (state.reviewExpanded.has(item.entityId)) {
    if (obs && !isRetest) {
      card.appendChild(el('div', { class: 'timeline-note', text: '下方时间线仅显示已有时间点；缺失段不补齐。' }));
      card.appendChild(specimenTimeline(obs, state.applied[state.filters.testId], result.stageStats));
    } else if (obs) {
      const runBlock = el('div', { class: 'retest-item' }, [
        el('span', { class: 'mono', text: item.runId }),
        el('span', { text: `开始 ${fmtTime(evaluated?.startedAt, { withDate: true })}` }),
        el('span', { text: `结果 ${fmtTime(evaluated?.resultedAt, { withDate: true })}` }),
        el('span', { text: `用时 ${fmtDuration(evaluated?.duration)}` })
      ]);
      card.appendChild(runBlock);
    }
  }

  return card;
}

function timeCell(label, ts) {
  const cell = el('div', { class: 'time-cell' + (ts == null ? ' missing' : '') }, [
    el('div', { class: 't-label', text: label }),
    el('div', { class: 't-val', text: ts == null ? '缺失' : fmtTime(ts, { withDate: true }) })
  ]);
  return cell;
}

// ---------- 规则面板 ----------

function draftFor(testId) {
  const applied = state.applied[testId];
  if (!state.drafts[testId] || state.drafts[testId].__base !== applied) {
    state.drafts[testId] = { ...structuredClone(applied), __base: applied };
  }
  return state.drafts[testId];
}

function renderRulesForm(result, rule) {
  const testId = state.filters.testId;
  const draft = draftFor(testId);
  $('rules-title').textContent = '规则配置';
  $('rules-test').textContent = `${result.test.name}（${result.test.code}）`;

  const wrap = $('rules-form');
  clearNode(wrap);

  // 目标时长
  const block1 = el('div', { class: 'rule-block', style: { marginTop: '0', paddingTop: '0', borderTop: '0' } });
  block1.appendChild(el('h3', { text: '目标时长（分钟）' }));
  const form = el('div', { class: 'form-grid' });
  const targetFields = [
    ['sampleToReceive', '采样 → 接收'],
    ['receiveToAnalyze', '接收 → 上机'],
    ['analyzeToResult', '上机 → 出结果'],
    ['total', '端到端（采样 → 出结果）']
  ];
  for (const [key, label] of targetFields) {
    const id = `target-${key}`;
    const input = el('input', {
      id,
      type: 'number',
      min: '0',
      step: '1',
      value: draft.targets[key] == null ? '' : String(draft.targets[key]),
      placeholder: '未设置'
    });
    input.addEventListener('input', () => {
      const v = input.value.trim();
      draft.targets[key] = v === '' ? null : Math.max(0, Number(v));
      markDirty();
      renderPreview();
    });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      input
    ]));
  }
  block1.appendChild(form);
  block1.appendChild(el('p', { class: 'field' }, [
    el('span', { class: 'hint', text: '端到端目标独立设置，不一定等于三段之和；空白表示该段不设目标。' })
  ]));
  wrap.appendChild(block1);

  // 纳入/排除
  const block2 = el('div', { class: 'rule-block' });
  block2.appendChild(el('h3', { text: '纳入与排除' }));

  const recollectCheck = el('input', { type: 'checkbox', id: 'rule-include-recollect', checked: !!draft.includeRecollect });
  recollectCheck.addEventListener('change', () => {
    draft.includeRecollect = recollectCheck.checked;
    markDirty();
    renderPreview();
  });
  block2.appendChild(el('label', { class: 'check-row', for: 'rule-include-recollect' }, [
    recollectCheck,
    el('span', {}, [
      el('span', { class: 'ro-label', text: '将重采标本计入均值' }),
      el('span', { class: 'ro-note', text: '默认排除。即使计入，同一患者仍只算 1 例独立患者。' })
    ])
  ]));

  const outlierId = 'rule-outlier';
  const outlierInput = el('input', {
    id: outlierId,
    type: 'number',
    min: '0',
    step: '1',
    value: draft.outlierMax == null ? '' : String(draft.outlierMax),
    placeholder: '例如 360'
  });
  outlierInput.addEventListener('input', () => {
    const v = outlierInput.value.trim();
    draft.outlierMax = v === '' ? null : Math.max(0, Number(v));
    markDirty();
    renderPreview();
  });
  block2.appendChild(el('div', { class: 'field', style: { marginTop: '12px' } }, [
    el('label', { for: outlierId, text: '极端值上限（分钟，总周转）' }),
    outlierInput,
    el('span', { class: 'hint', text: '超过上限的样本按“超限排除”移出均值；空白表示不排除。' })
  ]));
  wrap.appendChild(block2);

  // 停机处理
  const block3 = el('div', { class: 'rule-block' });
  block3.appendChild(el('h3', { text: '设备停机处理' }));
  const options = [
    ['mark', '保留并标注', '停机时长照常计入等待，样本页展示斜纹区间。适合先看真实体验。'],
    ['deduct', '从等待时长中扣除', '只扣“接收→上机”与停机窗口的重叠部分，其余阶段不变。'],
    ['exclude', '整体排除受影响样本', '凡与停机窗口有重叠的样本都不进均值，计入“停机受影响”。']
  ];
  const radioRow = el('div', { class: 'radio-row' });
  for (const [value, label, note] of options) {
    const id = `pause-${value}`;
    const radio = el('input', { type: 'radio', name: 'pause-policy', id, value, checked: draft.pausePolicy === value });
    radio.addEventListener('change', () => {
      if (radio.checked) {
        draft.pausePolicy = value;
        markDirty();
        renderPreview();
      }
    });
    radioRow.appendChild(el('label', { class: 'radio-opt', for: id }, [
      radio,
      el('span', {}, [
        el('span', { class: 'ro-label', text: label }),
        el('span', { class: 'ro-note', text: note })
      ])
    ]));
  }
  block3.appendChild(radioRow);
  wrap.appendChild(block3);

  block3.appendChild(el('p', {
    class: 'table-note',
    text: '待核对记录（缺少时间戳或顺序不合理）始终排除在均值与超时率之外，不受以上规则影响。'
  }));

  updateRuleActionState();
}

function markDirty() {
  updateRuleActionState();
}

function isDirty() {
  const draft = draftFor(state.filters.testId);
  const applied = state.applied[state.filters.testId];
  const strip = obj => {
    const { __base, ...rest } = obj;
    return JSON.stringify(rest);
  };
  return strip(draft) !== strip(applied);
}

function updateRuleActionState() {
  const dirty = isDirty();
  $('dirty-note').classList.toggle('hidden', !dirty);
  $('applied-note').classList.toggle('hidden', dirty);
  $('apply-rules').disabled = !dirty;
  $('reset-rules').disabled = false;
}

function applyDraftRules() {
  const testId = state.filters.testId;
  const draft = draftFor(testId);
  const { __base, ...clean } = structuredClone(draft);
  state.applied[testId] = clean;
  state.appliedAt[testId] = Date.now();
  state.drafts[testId] = null;
  renderAll();
}

function resetDraftRules() {
  const testId = state.filters.testId;
  const test = TEST_CATALOG.find(t => t.id === testId);
  state.drafts[testId] = { ...structuredClone(defaultRulesFor(test)), __base: state.applied[testId] };
  renderRulesForm(current, state.applied[testId]);
  renderPreview();
}

function renderPreview() {
  const testId = state.filters.testId;
  const draft = draftFor(testId);
  const { __base, ...draftClean } = draft;
  const draftRuleset = { ...state.applied, [testId]: draftClean };
  const diff = previewRuleChange(state.dataset, state.filters, state.applied, draftRuleset, TEST_CATALOG);
  const { before, after, added, removed, overdueAdded, overdueRemoved, deltas } = diff;

  const panel = $('preview-panel');
  const dirty = isDirty();

  $('preview-note').textContent = dirty
    ? `对比“已应用”与当前草稿：业务日 ${state.filters.dateFrom} → ${state.filters.dateTo}，${after.test.name}，${
        state.filters.department === 'all' ? '全部科室' : state.filters.department
      }。`
    : '草稿与已应用规则一致。修改任意目标或排除项，这里会实时显示受影响的数量变化。';

  const list = $('preview-deltas');
  clearNode(list);

  const rows = [
    {
      label: '纳入标本',
      before: `${before.totals.included} 例`,
      after: `${after.totals.included} 例`,
      delta: signed(deltas.included, ' 例'),
      cls: deltaClass(deltas.included, false)
    },
    {
      label: '中位总周转',
      before: fmtDuration(before.totals.median),
      after: fmtDuration(after.totals.median),
      delta: deltaTextDuration(deltas.median),
      cls: deltaClass(deltas.median, true)
    },
    {
      label: '超时样本',
      before: `${before.totals.overdue} 例`,
      after: `${after.totals.overdue} 例`,
      delta: signed(deltas.overdue, ' 例'),
      cls: deltaClass(deltas.overdue, true)
    },
    {
      label: '超时率',
      before: pct(before.totals.overdueRate, 1),
      after: pct(after.totals.overdueRate, 1),
      // 以“百分点”为单位计算差值再四舍五入到 1 位小数，避免浮点尾数（0.30000000000000004）
      delta: deltas.overdueRate == null
        ? '—'
        : signed(Math.round((after.totals.overdueRate - before.totals.overdueRate) * 1000) / 10, ' 个百分点'),
      cls: deltaClass(deltas.overdueRate, true)
    },
    {
      label: '待核对',
      before: `${before.totals.pending} 条`,
      after: `${after.totals.pending} 条`,
      delta: signed(deltas.pending, ' 条'),
      cls: 'delta-flat',
      note: '待核对由数据质量决定，规则不改变其结果'
    }
  ];

  for (const row of rows) {
    list.appendChild(el('div', { class: 'delta-row' }, [
      el('span', { class: 'dl', text: row.label }),
      el('span', {}, [
        el('span', { class: 'muted', style: { color: 'var(--ink-3)', fontSize: '11.5px' }, text: `${row.before} → ` }),
        el('span', { class: 'dv', text: row.after }),
        el('span', { class: 'dv ' + row.cls, style: { marginLeft: '8px', fontSize: '11.5px' }, text: `(${row.delta})` })
      ])
    ]));
    if (row.note) {
      list.appendChild(el('p', { class: 'preview-note', text: row.note }));
    }
  }

  const affected = $('preview-affected');
  clearNode(affected);
  if (!dirty) return;

  const groups = [
    { title: '新纳入', items: added.map(o => o.specimenId), tone: 'delta-down' },
    { title: '移出纳入', items: removed.map(o => o.specimenId), tone: 'delta-up' },
    { title: '新增超时', items: overdueAdded.map(o => o.specimenId), tone: 'delta-up' },
    { title: '移出超时', items: overdueRemoved.map(o => o.specimenId), tone: 'delta-down' }
  ];

  const any = groups.some(g => g.items.length);
  if (!any) {
    affected.appendChild(el('p', { class: 'preview-note', text: '应用后纳入集合与超时集合均无变化（仅目标或标注方式变化）。' }));
    return;
  }

  for (const g of groups) {
    if (!g.items.length) continue;
    const block = el('div', { class: 'affected-list' });
    block.appendChild(el('div', { class: 'preview-note', text: `${g.title} ${g.items.length} 例` }));
    block.appendChild(el('div', { class: 'mono', text: g.items.slice(0, 8).join('、') + (g.items.length > 8 ? ` … 等 ${g.items.length} 例` : '') }));
    affected.appendChild(block);
  }

  // 规则变更本身可能被用户误解 —— 明确提示口径
  if (draft.pausePolicy !== before.rule.pausePolicy) {
    affected.appendChild(el('p', {
      class: 'preview-warning',
      text: '设备停机口径发生变化：这会改变“接收→上机”的净时长与总周转，不会改变患者数。'
    }));
  }
  if (draft.includeRecollect !== before.rule.includeRecollect) {
    affected.appendChild(el('p', {
      class: 'preview-warning',
      text: '重采纳入口径发生变化：计入的是新的标本，不会把重采算成新的独立患者。'
    }));
  }
}

// ---------- 主题 ----------

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme === 'dark' ||
    (root.dataset.theme == null && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = isDark ? 'light' : 'dark';
  $('theme-toggle').textContent = isDark ? '深色' : '浅色';
  try {
    localStorage.setItem('turnaround-theme', root.dataset.theme);
  } catch {}
}

function restoreTheme() {
  try {
    const saved = localStorage.getItem('turnaround-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.dataset.theme = saved;
      $('theme-toggle').textContent = saved === 'dark' ? '浅色' : '深色';
    }
  } catch {}
}

boot();
