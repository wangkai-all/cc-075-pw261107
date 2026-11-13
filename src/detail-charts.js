import { svgEl, clear, bindTip } from './charts.js';
import { fmtDuration, axisFormatter, fmtTime } from './shift.js';
import { STAGES } from './analytics.js';

const SHIFT_COLORS = {
  morning: 'var(--series-1)',
  evening: 'var(--series-2)',
  night: 'var(--series-3)'
};

/**
 * 班次 × 阶段：每个阶段一根横向条，四个班次并排。
 * 颜色按班次（身份），数值标在条端。
 */
export function renderShiftStages(container, shifts, stageStats, rule, onShiftHover) {
  clear(container);
  if (!shifts.some(s => s.n > 0)) {
    const div = document.createElement('div');
    div.className = 'chart-empty';
    div.textContent = '当前筛选下没有可纳入统计的样本';
    container.appendChild(div);
    return;
  }

  const rows = [
    ...STAGES.map(st => ({ key: st.key, label: st.shortLabel, target: rule.targets[st.key] })),
    { key: 'total', label: '总周转', target: rule.targets.total }
  ];

  const W = 720;
  const rowH = 66;
  const topPad = 8;
  const H = topPad + 44 + rows.length * rowH + 30;
  const labelW = 82;
  const plotLeft = labelW + 8;
  const plotRight = W - 6;
  const plotW = plotRight - plotLeft;

  const allValues = [];
  for (const r of rows) {
    for (const s of shifts) {
      const st = r.key === 'total' ? s.stages.total : s.stages[r.key];
      if (st && st.median != null) allValues.push(st.median);
      if (st && st.p90 != null) allValues.push(st.p90);
      if (r.target != null) allValues.push(r.target);
    }
  }
  const domain = niceDomain(Math.max(...allValues, 10));

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': '各班次各阶段周转中位数与目标线对比'
  });

  // legend
  let lx = plotLeft;
  for (const s of shifts) {
    svg.appendChild(svgEl('rect', {
      x: lx, y: 0, width: 12, height: 12, rx: 3,
      fill: SHIFT_COLORS[s.id]
    }));
    svg.appendChild(svgEl('text', {
      x: lx + 18, y: 10, 'font-size': 11.5, fill: 'var(--ink-2)'
    }, `${s.name}（n=${s.n}）`));
    lx += 124;
  }

  rows.forEach((row, ri) => {
    const yBase = topPad + 44 + ri * rowH;
    const barGap = 5;
    const barH = Math.min(14, (rowH - 20 - barGap * (shifts.length - 1)) / shifts.length);

    // row label
    const label = svgEl('text', {
      x: 0, y: yBase + 4, 'font-size': 12, 'font-weight': 600, fill: 'var(--ink)'
    }, row.label);
    svg.appendChild(label);

    const targetX = row.target != null ? plotLeft + (row.target / domain.max) * plotW : null;

    // 目标竖线只覆盖该行的条形区域，不侵入数值标签
    if (targetX != null) {
      svg.appendChild(svgEl('line', {
        x1: targetX, x2: targetX,
        y1: yBase - 8, y2: yBase + barH * shifts.length + barGap * (shifts.length - 1) + 4,
        stroke: 'var(--ink-3)', 'stroke-width': 1, opacity: 0.75
      }));
    }

    shifts.forEach((s, si) => {
      const st = row.key === 'total' ? s.stages.total : s.stages[row.key];
      const y = yBase - 2 + si * (barH + barGap);
      const color = SHIFT_COLORS[s.id];
      if (!st || st.n === 0 || st.median == null) {
        svg.appendChild(svgEl('rect', {
          x: plotLeft, y, width: plotW, height: barH, rx: 4,
          fill: 'var(--surface-2)'
        }));
        svg.appendChild(svgEl('text', {
          x: plotLeft + 6, y: y + barH - 3, 'font-size': 10, fill: 'var(--ink-3)'
        }, '无样本'));
        return;
      }
      const mx = plotLeft + (Math.min(st.median, domain.max) / domain.max) * plotW;
      const p90x = plotLeft + (Math.min(st.p90, domain.max) / domain.max) * plotW;
      const over = row.target != null && st.median > row.target;

      // p90 淡背景
      svg.appendChild(svgEl('rect', {
        x: plotLeft, y, width: Math.max(2, p90x - plotLeft), height: barH, rx: 4,
        fill: color, opacity: 0.16
      }));
      // median bar
      svg.appendChild(svgEl('rect', {
        x: plotLeft, y, width: Math.max(2, mx - plotLeft), height: barH, rx: 4,
        fill: color
      }));

      // 数值放在 P90 段末端之外，避免压在浅色段上；空间不足时回到条内右端
      const valText = fmtDuration(st.median);
      let labelX = Math.max(mx, p90x) + 8;
      let anchor = 'start';
      if (labelX + 56 > plotRight) {
        labelX = plotRight;
        anchor = 'end';
      }
      svg.appendChild(svgEl('text', {
        x: labelX,
        y: y + barH - 3,
        'font-size': 10.5,
        'font-variant-numeric': 'tabular-nums',
        fill: over ? 'var(--critical)' : 'var(--ink-2)',
        'text-anchor': anchor
      }, valText));

      const hit = svgEl('rect', {
        x: plotLeft - 4, y: Math.max(0, y - barGap),
        width: plotW + 8, height: barH + barGap,
        fill: 'transparent', tabindex: 0, role: 'button',
        'aria-label': `${s.name} ${row.label} 中位 ${fmtDuration(st.median)}`
      });
      bindTip(hit, () => ({
        title: `${s.name} · ${row.label}`,
        rows: [
          { label: '中位', value: fmtDuration(st.median), color },
          { label: 'P90', value: fmtDuration(st.p90) },
          { label: '均值', value: fmtDuration(st.mean) },
          { label: '样本', value: `${st.n} 例` },
          { label: '目标', value: row.target == null ? '—' : fmtDuration(row.target) }
        ]
      }));
      svg.appendChild(hit);
    });
  });

  // x axis ticks at bottom，单位由整根轴的最大值决定（不混用 m / h）
  const axisY = H - 22;
  const tickLabel = axisFormatter(domain.max);
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const x = plotLeft + frac * plotW;
    svg.appendChild(svgEl('line', {
      x1: x, x2: x, y1: axisY, y2: axisY + 5,
      stroke: 'var(--axis)', 'stroke-width': 1
    }));
    svg.appendChild(svgEl('text', {
      x, y: axisY + 18, 'font-size': 10.5,
      'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle',
      fill: 'var(--ink-3)', 'font-variant-numeric': 'tabular-nums'
    }, tickLabel(domain.max * frac)));
  }
  svg.appendChild(svgEl('line', {
    x1: plotLeft, x2: plotRight, y1: axisY, y2: axisY,
    stroke: 'var(--axis)', 'stroke-width': 1
  }));

  container.appendChild(svg);

  const note = document.createElement('p');
  note.className = 'timeline-note';
  note.textContent = '实心段为中位数，浅色段延伸至 P90；灰竖线为项目目标，中线落在目标右侧即为中位超时。';
  container.appendChild(note);
}

function niceDomain(max) {
  const steps = [10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 7200];
  const found = steps.find(s => s >= max);
  const value = found || Math.ceil(max / 1440) * 1440;
  return { max: value };
}

/**
 * 科室横向条：按中位总周转时间排序，目标线置灰。
 */
export function renderDepartmentBars(container, departments, rule) {
  clear(container);
  const withData = departments.filter(d => d.n > 0 && d.medianTotal != null);
  if (!withData.length) {
    const div = document.createElement('div');
    div.className = 'chart-empty';
    div.textContent = '当前筛选下没有可纳入统计的样本';
    container.appendChild(div);
    return;
  }

  const sorted = [...withData].sort((a, b) => b.medianTotal - a.medianTotal);
  const rowH = 34;
  const top = 34;
  const W = 600;
  const H = top + sorted.length * rowH + 22;
  const labelW = 62;
  // 右侧两列：数值列固定起点，超时率列右对齐；两列都不压到条形
  const valueSpace = 138;
  const plotLeft = labelW + 8;
  const plotRight = W - valueSpace;
  const plotW = plotRight - plotLeft;
  const maxVal = Math.max(rule.targets.total || 0, ...sorted.map(d => d.medianTotal)) * 1.08;
  const scale = v => Math.max(2, (Math.min(v, maxVal) / maxVal) * plotW);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': '各科室中位总周转时间横向条形图'
  });

  const targetX = plotLeft + scale(rule.targets.total);

  sorted.forEach((d, i) => {
    const y = top + i * rowH;
    const w = scale(d.medianTotal);
    const over = d.medianTotal > rule.targets.total;
    svg.appendChild(svgEl('text', {
      x: 2, y: y + 16,
      'font-size': 11.5, fill: 'var(--ink-2)'
    }, d.name));
    svg.appendChild(svgEl('rect', {
      x: plotLeft, y: y + 6, width: w, height: 14, rx: 4,
      fill: over ? 'var(--critical)' : 'var(--series-1)'
    }));
    // 数值固定在绘图区外的列，避免与条端、超时百分比挤在一起
    svg.appendChild(svgEl('text', {
      x: plotRight + 8,
      y: y + 17,
      'font-size': 11, 'font-variant-numeric': 'tabular-nums',
      fill: 'var(--ink-2)'
    }, fmtDuration(d.medianTotal)));
    if (over) {
      svg.appendChild(svgEl('text', {
        x: W,
        y: y + 17,
        'font-size': 10.5, fill: 'var(--critical)', 'text-anchor': 'end'
      }, '超时 ' + Math.round(d.overdueRate * 100) + '%'));
    }

    const hit = svgEl('rect', {
      x: plotLeft - 4, y, width: plotW + valueSpace, height: rowH,
      fill: 'transparent', tabindex: 0, role: 'button',
      'aria-label': `${d.name} 中位 ${fmtDuration(d.medianTotal)}，超时率 ${Math.round((d.overdueRate ?? 0) * 100)}%`
    });
    bindTip(hit, () => ({
      title: d.name,
      rows: [
        { label: '中位总周转', value: fmtDuration(d.medianTotal), color: over ? 'var(--critical)' : 'var(--series-1)' },
        { label: '纳入标本', value: `${d.n} 例` },
        { label: '超时率', value: `${Math.round((d.overdueRate ?? 0) * 100)}%` },
        { label: '待核对', value: `${d.pending} 例` }
      ]
    }));
    svg.appendChild(hit);
  });

  // 目标标签放顶部，竖线只覆盖条形区域
  svg.appendChild(svgEl('text', {
    x: targetX, y: 14,
    'font-size': 10.5, fill: 'var(--ink-3)',
    'text-anchor': targetX > plotRight - 55 ? 'end' : 'start'
  }, `目标 ${fmtDuration(rule.targets.total)}`));
  svg.appendChild(svgEl('line', {
    x1: targetX, x2: targetX, y1: 20, y2: H - 22,
    stroke: 'var(--ink-3)', 'stroke-width': 1, opacity: 0.75
  }));

  container.appendChild(svg);
}

/**
 * 单样本时间线（展开行内）。
 * 返回 DOM 节点，调用方插入。
 */
export function specimenTimeline(obs, rule, stageStats) {
  const wrap = document.createElement('div');
  wrap.className = 'timeline';

  const points = [obs.collectedAt, obs.receivedAt, obs.analyzedAt, obs.resultedAt];
  const validPoints = points.filter(p => p != null);
  if (!validPoints.length) {
    const div = document.createElement('div');
    div.className = 'timeline-note';
    div.textContent = '缺少所有关键时间点，无法绘制时间线。';
    wrap.appendChild(div);
    return wrap;
  }

  const maxTs = Math.max(...validPoints);
  const minTs = Math.min(...validPoints);
  const shown_end = Math.max(maxTs, minTs + 60 * 60000);

  const stagesInfo = [
    { key: 'sampleToReceive', label: '采样→接收', from: obs.collectedAt, to: obs.receivedAt, color: 'var(--series-1)' },
    { key: 'receiveToAnalyze', label: '接收→上机', from: obs.receivedAt, to: obs.analyzedAt, color: 'var(--series-1)' },
    { key: 'analyzeToResult', label: '上机→结果', from: obs.analyzedAt, to: obs.resultedAt, color: 'var(--series-1)' }
  ];

  const bar = document.createElement('div');
  bar.className = 'timeline-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', '样本关键时间点时间线');

  let cursor = minTs;
  for (const st of stagesInfo) {
    if (st.from == null || st.to == null || st.to < st.from) continue;
    const widthPct = ((st.to - st.from) / (shown_end - minTs)) * 100;
    const seg = document.createElement('div');
    seg.className = 'timeline-seg';
    seg.style.width = `${Math.max(1, widthPct)}%`;
    seg.style.background = 'var(--blue-wash)';
    const dur = (st.to - st.from) / 60000;
    const target = rule.targets[st.key];
    const over = target != null && dur > target;
    if (over) {
      seg.style.background = 'var(--critical-wash)';
      seg.classList.add('over');
    }
    if (widthPct > 9) {
      seg.appendChild(document.createTextNode(`${Math.round(dur)}m`));
    }
    bindTip(seg, () => ({
      title: `${st.label} · ${obs.specimenId}`,
      rows: [
        { label: '时长', value: fmtDuration(dur), color: over ? 'var(--critical)' : 'var(--series-1)' },
        { label: '目标', value: target == null ? '—' : fmtDuration(target) },
        { label: '开始', value: fmtTime(st.from, { withDate: true }) },
        { label: '结束', value: fmtTime(st.to, { withDate: true }) }
      ]
    }));
    bar.appendChild(seg);
    cursor = st.to;
  }

  // 停机区间覆盖：按接收→上机窗口的绝对位置叠一个斜纹块
  if (obs.pauseHits && obs.pauseHits.length) {
    for (const hit of obs.pauseHits) {
      const leftPct = ((Math.max(hit.start, minTs) - minTs) / (shown_end - minTs)) * 100;
      const rightPct = ((Math.min(hit.end, shown_end) - minTs) / (shown_end - minTs)) * 100;
      if (rightPct <= 0 || leftPct >= 100) continue;
      const block = document.createElement('div');
      block.className = 'timeline-pause';
      block.style.left = `${Math.max(0, leftPct)}%`;
      block.style.width = `${Math.max(1.5, rightPct - Math.max(0, leftPct))}%`;
      bindTip(block, () => ({
        title: `${hit.device} 停机`,
        rows: [
          { label: '原因', value: hit.reason },
          { label: '重叠', value: fmtDuration(hit.overlapMinutes), color: 'var(--serious)' },
          { label: '窗口', value: `${fmtTime(hit.start)}–${fmtTime(hit.end)}` }
        ]
      }));
      bar.appendChild(block);
    }
  }

  wrap.appendChild(bar);

  const ticks = document.createElement('div');
  ticks.className = 'timeline-ticks';
  const t0 = document.createElement('span');
  t0.textContent = fmtTime(minTs);
  const tMid = document.createElement('span');
  tMid.textContent = fmtTime(minTs + (shown_end - minTs) / 2);
  const t1 = document.createElement('span');
  t1.textContent = fmtTime(shown_end);
  ticks.append(t0, tMid, t1);
  wrap.appendChild(ticks);

  // 四个时间点
  const times = document.createElement('div');
  times.className = 'timeline-times';
  const cells = [
    { label: '采样', ts: obs.collectedAt, delta: null },
    { label: '接收', ts: obs.receivedAt, delta: obs.effective.collectToReceive, target: rule.targets.sampleToReceive },
    { label: '上机', ts: obs.analyzedAt, delta: obs.effective.receiveToAnalyze, target: rule.targets.receiveToAnalyze },
    { label: '出结果', ts: obs.resultedAt, delta: obs.effective.analyzeToResult, target: rule.targets.analyzeToResult }
  ];
  for (const c of cells) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';
    if (c.ts == null) cell.classList.add('missing');
    const lb = document.createElement('div');
    lb.className = 't-label';
    lb.textContent = c.label;
    const val = document.createElement('div');
    val.className = 't-val';
    val.textContent = c.ts == null ? '缺失' : fmtTime(c.ts, { withDate: true });
    cell.append(lb, val);
    if (c.delta != null) {
      const d = document.createElement('div');
      d.className = 't-dur';
      const over = c.target != null && c.delta > c.target;
      d.textContent = `+${fmtDuration(c.delta)}${c.target != null ? ` / 目标 ${fmtDuration(c.target)}` : ''}`;
      if (over) d.style.color = 'var(--critical)';
      cell.appendChild(d);
    }
    times.appendChild(cell);
  }
  wrap.appendChild(times);

  if (obs.pauseHits && obs.pauseHits.length) {
    const n = document.createElement('div');
    n.className = 'timeline-note';
    const total = obs.pauseHits.reduce((a, b) => a + b.overlapMinutes, 0);
    n.textContent = `斜纹区域为设备停机：与接收→上机等待重叠 ${fmtDuration(total)}。当前规则：${
      rule.pausePolicy === 'deduct' ? '已从该阶段扣除' : rule.pausePolicy === 'exclude' ? '该样本被排除出均值' : '保留并标注，未做扣除'
    }。`;
    wrap.appendChild(n);
  }

  return wrap;
}

/**
 * 每段时长对目标的迷你仪表：不改变时间线比例，只补足“这段是否超”的可读性。
 * 轨道用同色系浅步进，超出目标的部分用 critical 色。
 */
export function stageMeters(obs, rule) {
  const wrap = document.createElement('div');
  wrap.className = 'stage-meters';
  const stages = [
    { key: 'sampleToReceive', label: '采样→接收', duration: 'collectToReceive' },
    { key: 'receiveToAnalyze', label: '接收→上机', duration: 'receiveToAnalyze' },
    { key: 'analyzeToResult', label: '上机→结果', duration: 'analyzeToResult' }
  ];
  let any = false;
  for (const st of stages) {
    const value = obs.effective?.[st.duration] ?? obs.raw[st.duration];
    if (value == null) continue;
    any = true;
    const target = rule.targets[st.key];
    // 仪表满格取目标的 2 倍，超过 2 倍按满格处理并在数值上说明
    const scaleMax = Math.max(target ?? 60, 1) * 2;
    const pct = Math.min(100, (value / scaleMax) * 100);
    const targetPct = target == null ? null : Math.min(100, (target / scaleMax) * 100);
    const over = target != null && value > target;

    const row = document.createElement('div');
    row.className = 'meter-row';

    const label = document.createElement('span');
    label.className = 'meter-label';
    label.textContent = st.label;

    const track = document.createElement('span');
    track.className = 'meter-track';
    const fill = document.createElement('span');
    fill.className = 'meter-fill' + (over ? ' over' : '');
    fill.style.width = `${Math.max(1.5, pct)}%`;
    if (!over) fill.style.background = 'var(--series-1)';
    track.appendChild(fill);
    if (targetPct != null) {
      const tick = document.createElement('span');
      tick.className = 'meter-tick';
      tick.style.left = `${targetPct}%`;
      track.appendChild(tick);
    }

    const valueEl = document.createElement('span');
    valueEl.className = 'meter-value' + (over ? ' over' : '');
    valueEl.textContent = `${fmtDuration(value)}${target == null ? '' : ` / ${fmtDuration(target)}`}`;

    bindTip(track, () => ({
      title: st.label,
      rows: [
        { label: '实际', value: fmtDuration(value), color: over ? 'var(--critical)' : 'var(--series-1)' },
        { label: '目标', value: target == null ? '未设置' : fmtDuration(target) },
        { label: '差异', value: target == null ? '—' : fmtDuration(Math.abs(value - target)), color: over ? 'var(--critical)' : 'var(--good-ink)' }
      ]
    }));

    row.append(label, track, valueEl);
    wrap.appendChild(row);
  }
  if (!any) {
    wrap.appendChild(Object.assign(document.createElement('div'), {
      className: 'timeline-note',
      textContent: '该样本缺少可计算的阶段时长。'
    }));
  }
  return wrap;
}
