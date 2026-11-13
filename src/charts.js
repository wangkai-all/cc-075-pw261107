// 轻量 SVG 图表组件。所有标签用 textContent 注入，避免数据污染 DOM。
import { axisFormatter, fmtDuration } from './shift.js';

const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------- tooltip ----------
let tipEl = null;
let tipHideTimer = null;

function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.dataset.open = 'false';
  document.body.appendChild(tipEl);
  return tipEl;
}

export function hideTip() {
  if (!tipEl) return;
  tipEl.dataset.open = 'false';
}

function positionTip(x, y) {
  const pad = 8;
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const left = Math.min(window.innerWidth - w / 2 - pad, Math.max(w / 2 + pad, x));
  const top = Math.max(h + 16, y);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function showTip(rows, title, x, y) {
  const t = ensureTip();
  clearTimeout(tipHideTimer);
  clear(t);
  if (title) {
    const head = document.createElement('div');
    head.className = 'tip-title';
    head.textContent = title;
    t.appendChild(head);
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'tip-row';
    const label = document.createElement('span');
    label.className = 'tip-label';
    if (row.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = row.color;
      label.appendChild(key);
    }
    label.appendChild(document.createTextNode(row.label));
    const val = document.createElement('span');
    val.className = 'tip-val';
    val.textContent = row.value;
    line.append(label, val);
    t.appendChild(line);
  }
  t.dataset.open = 'true';
  // 先显示再量尺寸，避免闪烁
  positionTip(x, y);
  requestAnimationFrame(() => positionTip(x, y));
}

export function bindTip(node, getContent) {
  const onMove = e => {
    const c = getContent();
    if (!c) return;
    showTip(c.rows, c.title, e.clientX, e.clientY);
  };
  const onEnter = e => onMove(e);
  const onLeave = () => hideTip();
  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('focus', () => {
    const rect = node.getBoundingClientRect();
    const c = getContent();
    if (!c) return;
    showTip(c.rows, c.title, rect.left + rect.width / 2, rect.top + 8);
  });
  node.addEventListener('blur', onLeave);
}

// ---------- 数值刻度 ----------
const NICE_STEPS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 10080];

export function niceMax(value) {
  if (!value || value <= 0) return 10;
  const step = NICE_STEPS.find(s => s >= value) || Math.ceil(value / 1440) * 1440;
  return step;
}

function esc(n) {
  return n;
}

function makeEmpty(container, message) {
  clear(container);
  const div = document.createElement('div');
  div.className = 'chart-empty';
  div.textContent = message;
  container.appendChild(div);
}

/** 取整刻度：0→最大值分成 2–3 段，每格整数分钟，且标签不会在窄面板里互相压住 */
function niceTicks(domain) {
  const candidates = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
  const fit = candidates.find(s => domain / s >= 2 && domain / s <= 3 && domain % s === 0);
  if (fit) {
    const out = [];
    for (let t = 0; t <= domain; t += fit) out.push(t);
    return out;
  }
  return [0, domain];
}

/**
 * 阶段分布小多图：每个阶段独立 x 轴，避免不同量级把短阶段压扁。
 * stages: [{ key, label, color, stats:{n,median,p10,p90,min,max}, target, overCount }]
 */
export function renderStageDistributions(container, stages, { onHover } = {}) {
  clear(container);
  const hasData = stages.some(s => s.stats && s.stats.n > 0);
  if (!hasData) {
    makeEmpty(container, '当前筛选下没有可纳入统计的样本');
    return;
  }

  const W = 760;
  const H = 210;
  const padX = 10;
  const gap = 26;
  const panelW = (W - padX * 2 - gap * (stages.length - 1)) / stages.length;
  const bandY = 112;
  const bandH = 15;
  const axisY = 184;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': '各阶段周转时长分布，P10 至 P90 区间、中位数与目标线'
  });

  stages.forEach((stage, i) => {
    const x0 = padX + i * (panelW + gap);
    const x1 = x0 + panelW;
    const s = stage.stats || {};
    const n = s.n || 0;

    // panel title / meta
    const title = svgEl('text', {
      x: x0,
      y: 17,
      'font-size': 13,
      'font-weight': 600,
      fill: 'var(--ink)'
    }, stage.label);
    svg.appendChild(title);

    // 一行元信息：n 用次级文字，超时数右对齐单独上色
    svg.appendChild(svgEl('text', {
      x: x0,
      y: 34,
      'font-size': 11.5,
      fill: 'var(--ink-2)'
    }, `n=${n}`));
    if (stage.overCount != null && n > 0) {
      svg.appendChild(svgEl('text', {
        x: x1,
        y: 34,
        'font-size': 11.5,
        'text-anchor': 'end',
        fill: stage.overCount > 0 ? 'var(--critical)' : 'var(--ink-3)'
      }, `超时 ${stage.overCount}`));
    }

    if (n === 0) {
      svg.appendChild(svgEl('text', {
        x: x0,
        y: 100,
        'font-size': 12,
        fill: 'var(--ink-3)'
      }, '无有效样本'));
      return;
    }

    const domain = niceMax(Math.max(s.p90 || 0, stage.target || 0) * 1.06);
    const xScale = v => x0 + (Math.min(v, domain) / domain) * (panelW);

    // baseline hairline
    svg.appendChild(svgEl('line', {
      x1: x0, x2: x1, y1: axisY, y2: axisY,
      stroke: 'var(--axis)', 'stroke-width': 1
    }));

    // axis ticks: 0 / … / max，统一由该面板的 domain 决定单位，刻度取整不出现 22.5 分
    const ticks = niceTicks(domain);
    const tickLabel = axisFormatter(domain);
    for (const t of ticks) {
      const tx = xScale(t);
      svg.appendChild(svgEl('line', {
        x1: tx, x2: tx, y1: axisY, y2: axisY + 5,
        stroke: 'var(--axis)', 'stroke-width': 1
      }));
      svg.appendChild(svgEl('text', {
        x: tx,
        y: axisY + 18,
        'font-size': 10.5,
        fill: 'var(--ink-3)',
        'text-anchor': t === 0 ? 'start' : t === domain ? 'end' : 'middle',
        'font-variant-numeric': 'tabular-nums'
      }, tickLabel(t)));
    }

    // whisker min→max
    if (s.min != null && s.max != null) {
      const mx0 = xScale(s.min);
      const mx1 = xScale(s.max);
      svg.appendChild(svgEl('line', {
        x1: mx0, x2: mx1, y1: bandY + bandH / 2, y2: bandY + bandH / 2,
        stroke: 'var(--axis)', 'stroke-width': 1
      }));
      for (const x of [mx0, mx1]) {
        svg.appendChild(svgEl('line', {
          x1: x, x2: x,
          y1: bandY + bandH / 2 - 5,
          y2: bandY + bandH / 2 + 5,
          stroke: 'var(--ink-3)', 'stroke-width': 1
        }));
      }
      if (s.max > domain) {
        svg.appendChild(svgEl('text', {
          x: x1,
          y: bandY - 6,
          'font-size': 10,
          fill: 'var(--ink-3)',
          'text-anchor': 'end'
        }, '…'));
      }
    }

    // p10–p90 band
    const bx0 = xScale(s.p10 ?? 0);
    const bx1 = xScale(s.p90 ?? 0);
    const bandW = Math.max(3, bx1 - bx0);
    svg.appendChild(svgEl('rect', {
      x: bx0,
      y: bandY,
      width: bandW,
      height: bandH,
      rx: 4,
      fill: stage.color
    }));

    // median: 2px ink line with 2px surface gap
    const medianX = xScale(s.median ?? 0);
    svg.appendChild(svgEl('rect', {
      x: medianX - 5, y: bandY - 6,
      width: 10, height: bandH + 12,
      fill: 'var(--surface)'
    }));
    svg.appendChild(svgEl('line', {
      x1: medianX, x2: medianX,
      y1: bandY - 4, y2: bandY + bandH + 4,
      stroke: 'var(--ink)', 'stroke-width': 2
    }));

    // 两个标签分两行：目标在上、中位在下，永远不互相压住
    const tx = stage.target != null ? xScale(stage.target) : null;
    const medianLabelX = Math.min(x1 - 2, Math.max(x0 + 2, medianX));
    svg.appendChild(svgEl('text', {
      x: medianLabelX,
      y: bandY - 12,
      'font-size': 11.5,
      'font-weight': 650,
      fill: 'var(--ink)',
      'text-anchor': medianX - x0 < 34 ? 'start' : medianX - x0 > panelW - 34 ? 'end' : 'middle',
      'font-variant-numeric': 'tabular-nums'
    }, `中位 ${fmtDuration(s.median)}`));

    if (tx != null) {
      svg.appendChild(svgEl('line', {
        x1: tx, x2: tx, y1: bandY, y2: axisY,
        stroke: 'var(--ink-3)', 'stroke-width': 1
      }));
      svg.appendChild(svgEl('rect', {
        x: tx - 3, y: bandY - 4,
        width: 6, height: 8,
        rx: 1,
        fill: 'var(--ink-3)'
      }));
      svg.appendChild(svgEl('text', {
        x: tx,
        y: 82,
        'font-size': 10.5,
        fill: 'var(--ink-3)',
        'text-anchor': tx - x0 < 44 ? 'start' : tx - x0 > panelW - 44 ? 'end' : 'middle'
      }, `目标 ${fmtDuration(stage.target)}`));
    }

    // hover target
    const hit = svgEl('rect', {
      x: x0 - 4,
      y: 40,
      width: panelW + 8,
      height: axisY - 40 + 26,
      fill: 'transparent',
      tabindex: 0,
      role: 'button',
      'aria-label': `${stage.label}：中位 ${fmtDuration(s.median)}，P10–P90 ${fmtDuration(s.p10)} 至 ${fmtDuration(s.p90)}`
    });
    if (onHover) {
      bindTip(hit, () => onHover(stage));
    }
    svg.appendChild(hit);
  });

  container.appendChild(svg);
}

/** 班次口径小示意图：一夜班跨日的归属 */export function renderShiftDayStrip(container) {
  clear(container);
  const svg = svgEl('svg', {
    viewBox: '0 0 760 74',
    role: 'img',
    'aria-label': '班次时间带：夜班 00:00 至 08:00 归属前一业务日'
  });
  const blocks = [
    { label: '夜班', time: '00–08', start: 0, end: 8, fill: 'var(--series-2)', ink: '#ffffff', note: '归前一业务日' },
    { label: '白班', time: '08–16', start: 8, end: 16, fill: 'var(--surface-2)', ink: 'var(--ink)', note: '当日' },
    { label: '中班', time: '16–24', start: 16, end: 24, fill: 'var(--surface-2)', ink: 'var(--ink)', note: '当日' }
  ];
  const x0 = 8;
  const w = 744;
  for (const b of blocks) {
    const bx = x0 + (b.start / 24) * w;
    const bw = ((b.end - b.start) / 24) * w;
    svg.appendChild(svgEl('rect', {
      x: bx + 1, y: 8, width: bw - 2, height: 30, rx: 6,
      fill: b.fill,
      stroke: b.fill === 'var(--surface-2)' ? 'var(--border)' : 'none',
      'stroke-width': 1
    }));
    svg.appendChild(svgEl('text', {
      x: bx + bw / 2, y: 27,
      'font-size': 12, 'font-weight': 600,
      'text-anchor': 'middle',
      fill: b.ink
    }, `${b.label} ${b.time}`));
  }
  // 箭头提示跨日
  svg.appendChild(svgEl('path', {
    d: `M ${x0 + 8} 50 L ${x0 + 8} 58 L ${x0 + w * 8 / 24} 58`,
    stroke: 'var(--series-2)', 'stroke-width': 2, fill: 'none',
    'stroke-linecap': 'round'
  }));
  svg.appendChild(svgEl('path', {
    d: `M ${x0 + w * 8 / 24 - 1} 53 L ${x0 + w * 8 / 24 + 5} 58 L ${x0 + w * 8 / 24 - 1} 63`,
    stroke: 'var(--series-2)', 'stroke-width': 2, fill: 'none',
    'stroke-linecap': 'round'
  }));
  svg.appendChild(svgEl('text', {
    x: x0 + w * 8 / 24 + 12, y: 62,
    'font-size': 11, fill: 'var(--ink-3)'
  }, '夜班 00:00–08:00 的采样计入前一业务日，跨日不拆成两个班次'));
  container.appendChild(svg);
}
