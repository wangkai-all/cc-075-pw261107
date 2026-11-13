// 生成一份确定性的虚构检验周转数据集。
// 不含真实机构、人员或患者信息；患者键为随机匿名编号。
// 运行：node scripts/generate-data.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DAYS = 27;
const START_DAY = Date.UTC(2026, 9, 17); // 2026-10-17
const TZ_NOTE = 'UTC';

const DEPARTMENTS = ['急诊科', 'ICU', '内科', '外科', '儿科', '门诊'];

const TESTS = [
  {
    id: 'cbc',
    name: '血常规',
    code: 'CBC',
    perDay: 11,
    shiftWeights: [0.34, 0.36, 0.30],
    deptWeights: { 急诊科: 0.28, ICU: 0.08, 内科: 0.29, 外科: 0.15, 儿科: 0.12, 门诊: 0.08 },
    profile: { c2r: 18, r2a: 15, a2r: 34, sigmas: [0.55, 0.5, 0.4] }
  },
  {
    id: 'coag',
    name: '凝血功能',
    code: 'PT/APTT',
    perDay: 8,
    shiftWeights: [0.36, 0.36, 0.28],
    deptWeights: { 急诊科: 0.25, ICU: 0.15, 内科: 0.30, 外科: 0.15, 儿科: 0.05, 门诊: 0.10 },
    profile: { c2r: 17, r2a: 10, a2r: 26, sigmas: [0.55, 0.5, 0.4] }
  },
  {
    id: 'chem',
    name: '生化全套',
    code: 'BIO',
    perDay: 10,
    shiftWeights: [0.44, 0.38, 0.18],
    deptWeights: { 急诊科: 0.25, ICU: 0.15, 内科: 0.30, 外科: 0.12, 儿科: 0.06, 门诊: 0.12 },
    profile: { c2r: 22, r2a: 22, a2r: 45, sigmas: [0.5, 0.45, 0.4] }
  },
  {
    id: 'trop',
    name: '高敏肌钙蛋白',
    code: 'hs-cTn',
    perDay: 7,
    shiftWeights: [0.20, 0.38, 0.42],
    deptWeights: { 急诊科: 0.55, ICU: 0.30, 内科: 0.13, 外科: 0.02, 儿科: 0, 门诊: 0 },
    profile: { c2r: 12, r2a: 7, a2r: 20, sigmas: [0.5, 0.45, 0.35] }
  },
  {
    id: 'culture',
    name: '血培养',
    code: 'CULT',
    perDay: 4,
    shiftWeights: [0.38, 0.42, 0.20],
    deptWeights: { 急诊科: 0.12, ICU: 0.40, 内科: 0.28, 外科: 0.18, 儿科: 0.02, 门诊: 0 },
    profile: { c2r: 40, r2a: 70, a2r: 1900, sigmas: [0.5, 0.55, 0.4] }
  }
];

const SHIFTS = [
  { id: 'morning', name: '白班', startMin: 8 * 60 },
  { id: 'evening', name: '中班', startMin: 16 * 60 },
  { id: 'night', name: '夜班', startMin: 0, nextDay: true }
];

const PAUSES = [
  {
    id: 'PAUSE-01',
    device: '血液分析流水线',
    testIds: ['cbc'],
    start: '2026-10-21T02:00:00.000Z',
    end: '2026-10-21T05:30:00.000Z',
    reason: '质控失控，停机校准'
  },
  {
    id: 'PAUSE-02',
    device: '凝血分析仪',
    testIds: ['coag'],
    start: '2026-10-26T18:20:00.000Z',
    end: '2026-10-26T21:00:00.000Z',
    reason: '试剂批号更换与定标'
  },
  {
    id: 'PAUSE-03',
    device: '生化流水线',
    testIds: ['chem'],
    start: '2026-11-02T09:30:00.000Z',
    end: '2026-11-02T12:30:00.000Z',
    reason: '样本针堵塞'
  },
  {
    id: 'PAUSE-04',
    device: '血培养仪',
    testIds: ['culture'],
    start: '2026-11-06T00:30:00.000Z',
    end: '2026-11-06T04:00:00.000Z',
    reason: '温控模块维护'
  },
  {
    id: 'PAUSE-05',
    device: '免疫分析仪',
    testIds: ['trop'],
    start: '2026-11-10T07:10:00.000Z',
    end: '2026-11-10T09:10:00.000Z',
    reason: '定标失败，重新定标'
  },
  {
    id: 'PAUSE-06',
    device: '血液分析流水线',
    testIds: ['cbc', 'coag'],
    start: '2026-11-11T15:40:00.000Z',
    end: '2026-11-11T18:10:00.000Z',
    reason: '进样轨道故障'
  }
];

const CANCEL_REASONS = ['标本量不足', '标本溶血', '重复采集', '医嘱取消', '信息不一致', '容器错误'];

// ---------- 确定性随机 ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261113);

function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function normal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function logNormal(median, sigma) {
  return median * Math.exp(sigma * normal());
}
function weightedPick(weights, keys) {
  const total = keys.reduce((sum, k) => sum + (weights[k] || 0), 0);
  let r = rand() * total;
  for (const k of keys) {
    r -= weights[k] || 0;
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

function iso(ms) {
  return new Date(Math.round(ms / 60000) * 60000).toISOString();
}

// 患者复诊只在近期发生：同一患者可能在同一班次/相邻几天再次采样，
// 但不会跨两周随机复用，避免让“独立患者”口径失真。
const patientsByDay = new Map(); // dayIndex -> [patientKey]
let patientSeq = 1;
function newPatient(dayIndex) {
  const key = `P-26-${String(patientSeq++).padStart(4, '0')}`;
  const list = patientsByDay.get(dayIndex) || [];
  list.push(key);
  patientsByDay.set(dayIndex, list);
  return key;
}
function patientForDraw(dayIndex) {
  // 30% 概率复用前 3 天内的患者（复查/连续监测），否则新患者
  if (rand() < 0.30) {
    for (let back = 0; back <= 2; back++) {
      const list = patientsByDay.get(dayIndex - back);
      if (list && list.length) return pick(list);
    }
  }
  return newPatient(dayIndex);
}

function shiftStart(dayMs, shift) {
  const base = dayMs + shift.startMin * 60000;
  return shift.nextDay ? base + 86400000 : base;
}

function shiftLabelByHour(ms) {
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minutes >= 8 * 60 && minutes < 16 * 60) return 'morning';
  if (minutes >= 16 * 60) return 'evening';
  return 'night';
}

const pauseWindows = PAUSES.map(p => ({
  ...p,
  startMs: Date.parse(p.start),
  endMs: Date.parse(p.end)
}));

function applyPauseDelay(testId, receivedAt, analyzedAt) {
  let out = analyzedAt;
  for (const p of pauseWindows) {
    if (!p.testIds.includes(testId)) continue;
    // 接收点落在停机期内：上机被推迟到停机结束
    if (receivedAt >= p.startMs && receivedAt < p.endMs) {
      out = Math.max(out, p.endMs + randInt(3, 25) * 60000);
    }
  }
  return out;
}

function shiftMultipliers(testId, shiftId) {
  if (testId === 'trop') {
    return { c2r: shiftId === 'night' ? 1.12 : shiftId === 'evening' ? 1.04 : 1, r2a: shiftId === 'night' ? 1.08 : 1, a2r: 1 };
  }
  if (testId === 'culture') {
    return { c2r: shiftId === 'night' ? 1.2 : 1.05, r2a: shiftId === 'night' ? 1.15 : 1.05, a2r: shiftId === 'evening' ? 1.08 : 1.18 };
  }
  return {
    c2r: shiftId === 'night' ? 1.38 : shiftId === 'evening' ? 1.08 : 1,
    r2a: shiftId === 'night' ? 1.28 : shiftId === 'evening' ? 1.05 : 1,
    a2r: shiftId === 'night' ? 1.1 : 1.02
  };
}

function deptMultiplier(testId, dept) {
  if (testId === 'trop') {
    if (dept === '急诊科') return 0.9;
    if (dept === 'ICU') return 0.98;
    return 1;
  }
  if (dept === '门诊') return 0.96;
  if (dept === 'ICU') return 1.06;
  if (dept === '儿科') return 1.03;
  return 1;
}

let specimenSeq = 0;
const specimens = [];

for (let d = 0; d < DAYS; d++) {
  const dayMs = START_DAY + d * 86400000;
  const weekday = new Date(dayMs).getUTCDay();
  const dayFactor = weekday === 0 || weekday === 6 ? 0.82 : weekday === 1 ? 1.08 : 1;

  for (const test of TESTS) {
    const baseCount = Math.max(1, Math.round(test.perDay * dayFactor * (0.9 + rand() * 0.22)));
    const shiftCounts = splitCounts(baseCount, test.shiftWeights);
    for (const [si, shift] of SHIFTS.entries()) {
      const count = shiftCounts[si];
      for (let i = 0; i < count; i++) {
        const dept = weightedPick(test.deptWeights, DEPARTMENTS);
        const startMs = shiftStart(dayMs, shift);
        const window = shift.id === 'night' ? 8 * 60 : 8 * 60;
        const collectedAt = startMs + randInt(4, window - 12) * 60000;
        const mult = shiftMultipliers(test.id, shift.id);
        const deptMult = deptMultiplier(test.id, dept);

        const c2r = Math.min(240, Math.max(2, Math.round(logNormal(test.profile.c2r, test.profile.sigmas[0]) * mult.c2r)));
        const r2a = Math.min(360, Math.max(1, Math.round(logNormal(test.profile.r2a, test.profile.sigmas[1]) * mult.r2a * deptMult)));
        const a2r = Math.min(5400, Math.max(5, Math.round(logNormal(test.profile.a2r, test.profile.sigmas[2]) * mult.a2r)));

        let receivedAt = collectedAt + c2r * 60000;
        let analyzedAt = receivedAt + r2a * 60000;
        analyzedAt = applyPauseDelay(test.id, receivedAt, analyzedAt);
        let resultedAt = analyzedAt + a2r * 60000;

        specimens.push({
          specimenId: `S${new Date(dayMs).toISOString().slice(2, 10).replace(/-/g, '')}-${String(++specimenSeq).padStart(4, '0')}`,
          patientKey: patientForDraw(d),
          testId: test.id,
          department: dept,
          collectedAt,
          receivedAt,
          analyzedAt,
          resultedAt,
          status: 'reported',
          runKind: 'original',
          recollectOf: null,
          retestRuns: []
        });
      }
    }
  }
}

function splitCounts(total, weights) {
  const counts = [];
  let left = total;
  for (let i = 0; i < weights.length - 1; i++) {
    const n = Math.round(total * weights[i]);
    counts.push(n);
    left -= n;
  }
  counts.push(left);
  // 非负兜底
  return counts.map(n => Math.max(0, n));
}

// ---------- 设备停机调整后的真实出结果时间已在生成时处理 ----------

// ---------- 取消 ----------
const cancelledIds = [];
for (const s of specimens) {
  if (rand() < 0.028) {
    s.status = 'cancelled';
    s.cancelledAt = s.collectedAt + randInt(8, 95) * 60000;
    s.cancelReason = pick(CANCEL_REASONS);
    // 取消样本多数没有上机/出结果时间
    if (rand() < 0.72) {
      s.analyzedAt = null;
      s.resultedAt = null;
    }
    cancelledIds.push(s.specimenId);
  }
}

// ---------- 缺失时间戳 / 顺序异常 ----------
let invalidCount = 0;
for (const s of specimens) {
  if (s.status === 'cancelled') continue;
  if (rand() >= 0.021) continue;
  invalidCount++;
  const kind = randInt(1, 4);
  if (kind === 1) {
    s.resultedAt = null;
  } else if (kind === 2) {
    s.analyzedAt = null;
    s.resultedAt = null;
  } else if (kind === 3) {
    // 上机早于接收
    s.analyzedAt = s.receivedAt - randInt(2, 18) * 60000;
    s.resultedAt = Math.max(s.resultedAt || 0, s.analyzedAt + randInt(15, 40) * 60000);
  } else {
    // 出结果早于上机
    s.resultedAt = s.analyzedAt - randInt(1, 12) * 60000;
  }
}

// ---------- 极端延迟（纳入，除非配置 outlierMax 排除） ----------
for (const s of specimens) {
  if (s.status === 'cancelled' || !s.resultedAt) continue;
  if (rand() < 0.022) {
    const extra = randInt(120, 420) * 60000;
    if (rand() < 0.5) {
      s.analyzedAt += extra;
      s.resultedAt += extra;
    } else {
      s.resultedAt += extra;
    }
  }
}

// ---------- 复测轮次（不算独立患者/样本） ----------
for (const s of specimens) {
  if (s.status === 'cancelled') continue;
  if (rand() >= 0.072) continue;
  const runs = rand() < 0.22 ? 2 : 1;
  let cursor = s.resultedAt || s.analyzedAt || s.collectedAt;
  for (let r = 0; r < runs; r++) {
    const startedAt = cursor + randInt(6, 38) * 60000;
    const durationMin = randInt(12, 65);
    const resultedAt = startedAt + durationMin * 60000;
    const run = {
      runId: `${s.specimenId}-R${r + 1}`,
      startedAt,
      resultedAt,
      reason: pick(['质控复测', '结果异常复核', '仪器报警', '稀释复测'])
    };
    if (rand() < 0.12) {
      if (rand() < 0.5) run.resultedAt = null;
      else run.resultedAt = startedAt - randInt(2, 9) * 60000;
    }
    s.retestRuns.push(run);
    cursor = resultedAt;
  }
}

// ---------- 重采（同一患者，关联原样本） ----------
const recollects = [];
for (const s of specimens) {
  if (s.runKind !== 'original') continue;
  if (s.status !== 'cancelled' && s.retestRuns.length === 0) continue;
  if (rand() >= 0.35) continue;
  const newCollected = s.collectedAt + randInt(25, 210) * 60000;
  const test = TESTS.find(t => t.id === s.testId);
  const shiftId = shiftLabelByHour(newCollected);
  const mult = shiftMultipliers(s.testId, shiftId);
  const c2r = Math.max(2, Math.round(logNormal(test.profile.c2r, test.profile.sigmas[0]) * mult.c2r));
  const r2a = Math.max(1, Math.round(logNormal(test.profile.r2a, test.profile.sigmas[1]) * mult.r2a));
  const a2r = Math.max(5, Math.round(logNormal(test.profile.a2r, test.profile.sigmas[2]) * mult.a2r));
  const receivedAt = newCollected + c2r * 60000;
  const analyzedAt = receivedAt + r2a * 60000;
  const resultedAt = analyzedAt + a2r * 60000;
  const re = {
    specimenId: `${s.specimenId}-RE`,
    patientKey: s.patientKey,
    testId: s.testId,
    department: s.department,
    collectedAt: newCollected,
    receivedAt,
    analyzedAt,
    resultedAt,
    status: 'reported',
    runKind: 'recollect',
    recollectOf: s.specimenId,
    retestRuns: []
  };
  recollects.push(re);
}
specimens.push(...recollects);

// ---------- 排序并输出 ----------
specimens.sort((a, b) => a.collectedAt - b.collectedAt);

const outSpecimens = specimens.map(s => ({
  specimenId: s.specimenId,
  patientKey: s.patientKey,
  testId: s.testId,
  department: s.department,
  collectedAt: iso(s.collectedAt),
  receivedAt: s.receivedAt == null ? null : iso(s.receivedAt),
  analyzedAt: s.analyzedAt == null ? null : iso(s.analyzedAt),
  resultedAt: s.resultedAt == null ? null : iso(s.resultedAt),
  cancelledAt: s.cancelledAt == null ? null : iso(s.cancelledAt),
  cancelReason: s.cancelReason ?? null,
  status: s.status,
  runKind: s.runKind,
  recollectOf: s.recollectOf,
  retestRuns: s.retestRuns.map(r => ({
    runId: r.runId,
    startedAt: r.startedAt == null ? null : iso(r.startedAt),
    resultedAt: r.resultedAt == null ? null : iso(r.resultedAt),
    reason: r.reason
  }))
}));

const data = {
  meta: {
    title: '虚构检验周转数据集',
    synthetic: true,
    timezone: TZ_NOTE,
    generatedOn: '2026-11-13',
    dateRange: {
      from: iso(START_DAY).slice(0, 10),
      to: iso(START_DAY + (DAYS - 1) * 86400000).slice(0, 10)
    },
    note: '所有标本号、患者键、科室与设备均为虚构，不包含真实个人信息。'
  },
  departments: DEPARTMENTS,
  devicePauses: PAUSES,
  specimens: outSpecimens
};

const outPath = path.join(ROOT, 'data', 'dataset.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');

const byTest = {};
for (const s of outSpecimens) byTest[s.testId] = (byTest[s.testId] || 0) + 1;
console.log(`Wrote ${outSpecimens.length} specimens to ${outPath}`);
console.log('By test:', byTest);
console.log('Invalid primary:', invalidCount, '| cancelled:', cancelledIds.length, '| recollects:', recollects.length);
console.log('Unique patients:', patientSeq - 1);
