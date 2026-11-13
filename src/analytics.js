// 分析层：样本级归并、时间点校验、阶段拆分、规则评估与聚合。
// 全部为纯函数，便于单元测试。

import { resolveShift, SHIFT_ORDER, DEFAULT_SHIFTS } from './shift.js';

export const STAGES = [
  {
    key: 'sampleToReceive',
    label: '采样 → 接收',
    shortLabel: '采样→接收',
    from: 'collectedAt',
    to: 'receivedAt',
    duration: 'collectToReceive'
  },
  {
    key: 'receiveToAnalyze',
    label: '接收 → 上机',
    shortLabel: '接收→上机',
    from: 'receivedAt',
    to: 'analyzedAt',
    duration: 'receiveToAnalyze'
  },
  {
    key: 'analyzeToResult',
    label: '上机 → 出结果',
    shortLabel: '上机→结果',
    from: 'analyzedAt',
    to: 'resultedAt',
    duration: 'analyzeToResult'
  }
];

export const TOTAL_STAGE = {
  key: 'total',
  label: '采样 → 出结果',
  shortLabel: '总周转',
  duration: 'total'
};

const TS_LABELS = {
  collectedAt: '采样时间',
  receivedAt: '接收时间',
  analyzedAt: '上机时间',
  resultedAt: '出结果时间'
};

export function defaultRulesFor(test) {
  return {
    targets: { ...test.target },
    includeRecollect: false,
    pausePolicy: 'mark', // mark=保留并标注 / deduct=扣除停摆时长 / exclude=排除受影响样本
    outlierMax: null
  };
}

export function buildRuleset(catalog, overrides = {}) {
  const out = {};
  for (const test of catalog) {
    out[test.id] = deepMerge(defaultRulesFor(test), overrides[test.id] || {});
  }
  return out;
}

function deepMerge(base, extra) {
  const targets = { ...base.targets, ...(extra.targets || {}) };
  return { ...base, ...extra, targets };
}

/** 数值百分位（线性插值） */
export function percentile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

export function stats(values) {
  const clean = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!clean.length) {
    return { n: 0, mean: null, median: null, p10: null, p90: null, min: null, max: null };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toMs(v) {
  return typeof v === 'number' ? v : Date.parse(v);
}

function intervalOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * 计算设备暂停与“接收→上机”等待窗口的重叠。
 * 只统计与该检验项目相关的停机窗口。
 */
export function pauseOverlapFor(specimen, pauses) {
  if (!isNum(specimen.receivedAt) || !isNum(specimen.analyzedAt)) {
    return { overlapMinutes: 0, pauses: [] };
  }
  const from = Math.min(specimen.receivedAt, specimen.analyzedAt);
  const to = Math.max(specimen.receivedAt, specimen.analyzedAt);
  let total = 0;
  const hits = [];
  for (const p of pauses) {
    if (p.testIds && !p.testIds.includes(specimen.testId)) continue;
    const ov = intervalOverlap(from, to, p.start, p.end);
    if (ov > 0) {
      total += ov / 60000;
      hits.push({ ...p, overlapMinutes: ov / 60000 });
    }
  }
  return { overlapMinutes: total, pauses: hits };
}

/** 单个标本（含复测轮次）标准化为分析对象 */
export function normalizeSpecimen(specimen, pauses = []) {
  const { shift, businessDay } = isNum(specimen.collectedAt)
    ? resolveShift(specimen.collectedAt)
    : { shift: null, businessDay: null };

  const cancelled = specimen.status === 'cancelled';
  const issues = [];
  const required = cancelled
    ? ['collectedAt']
    : ['collectedAt', 'receivedAt', 'analyzedAt', 'resultedAt'];

  for (const field of required) {
    if (!isNum(specimen[field])) {
      issues.push({
        code: 'missing',
        field,
        message: `缺少${TS_LABELS[field]}`
      });
    }
  }

  const orderPairs = [
    ['collectedAt', 'receivedAt'],
    ['receivedAt', 'analyzedAt'],
    ['analyzedAt', 'resultedAt']
  ];
  for (const [a, b] of orderPairs) {
    if (isNum(specimen[a]) && isNum(specimen[b]) && specimen[b] < specimen[a]) {
      issues.push({
        code: 'order',
        field: b,
        message: `${TS_LABELS[b]}早于${TS_LABELS[a]}`
      });
    }
  }

  // 取消时间不应早于采样
  if (cancelled && isNum(specimen.cancelledAt) && isNum(specimen.collectedAt) && specimen.cancelledAt < specimen.collectedAt) {
    issues.push({ code: 'order', field: 'cancelledAt', message: '取消时间早于采样时间' });
  }

  const raw = {
    collectToReceive:
      isNum(specimen.collectedAt) && isNum(specimen.receivedAt)
        ? (specimen.receivedAt - specimen.collectedAt) / 60000
        : null,
    receiveToAnalyze:
      isNum(specimen.receivedAt) && isNum(specimen.analyzedAt)
        ? (specimen.analyzedAt - specimen.receivedAt) / 60000
        : null,
    analyzeToResult:
      isNum(specimen.analyzedAt) && isNum(specimen.resultedAt)
        ? (specimen.resultedAt - specimen.analyzedAt) / 60000
        : null,
    total:
      isNum(specimen.collectedAt) && isNum(specimen.resultedAt)
        ? (specimen.resultedAt - specimen.collectedAt) / 60000
        : null
  };

  const overlap = pauseOverlapFor(specimen, pauses);

  const retestRuns = (specimen.retestRuns || []).map((run, idx) => {
    const runIssues = [];
    if (!isNum(run.startedAt)) {
      runIssues.push({ code: 'missing', field: 'startedAt', message: '缺少复测开始时间' });
    }
    if (!isNum(run.resultedAt)) {
      runIssues.push({ code: 'missing', field: 'resultedAt', message: '缺少复测出结果时间' });
    }
    if (isNum(run.startedAt) && isNum(run.resultedAt) && run.resultedAt < run.startedAt) {
      runIssues.push({ code: 'order', field: 'resultedAt', message: '复测出结果早于复测开始' });
    }
    return {
      runId: run.runId || `${specimen.specimenId}-R${idx + 1}`,
      specimenId: specimen.specimenId,
      testId: specimen.testId,
      department: specimen.department,
      patientKey: specimen.patientKey,
      businessDay,
      shiftId: shift?.id ?? null,
      collectedAt: specimen.collectedAt,
      startedAt: run.startedAt ?? null,
      resultedAt: run.resultedAt ?? null,
      duration:
        isNum(run.startedAt) && isNum(run.resultedAt)
          ? (run.resultedAt - run.startedAt) / 60000
          : null,
      issueCount: runIssues.length,
      issues: runIssues,
      valid: runIssues.length === 0
    };
  });

  return {
    specimenId: specimen.specimenId,
    patientKey: specimen.patientKey,
    testId: specimen.testId,
    department: specimen.department,
    collectedAt: specimen.collectedAt,
    receivedAt: specimen.receivedAt ?? null,
    analyzedAt: specimen.analyzedAt ?? null,
    resultedAt: specimen.resultedAt ?? null,
    cancelledAt: specimen.cancelledAt ?? null,
    cancelReason: specimen.cancelReason ?? null,
    status: specimen.status || 'reported',
    cancelled,
    runKind: specimen.runKind || 'original',
    recollectOf: specimen.recollectOf || null,
    retestRuns,
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? null,
    businessDay,
    issues,
    valid: issues.length === 0,
    raw,
    pauseOverlap: overlap.overlapMinutes,
    pauseHits: overlap.pauses,
    pauseAffected: overlap.overlapMinutes > 0,
    effective: null
  };
}

/** 应用项目规则，计算净时长与是否纳入均值 */
export function applyRuleToObservation(obs, rule) {
  const overlap = rule.pausePolicy === 'deduct' ? obs.pauseOverlap : 0;
  const receiveToAnalyzeRaw = obs.raw.receiveToAnalyze;
  const effective = {
    collectToReceive: obs.raw.collectToReceive,
    receiveToAnalyze:
      receiveToAnalyzeRaw == null ? null : Math.max(0, receiveToAnalyzeRaw - overlap),
    analyzeToResult: obs.raw.analyzeToResult,
    total:
      obs.raw.total == null ? null : Math.max(0, obs.raw.total - overlap)
  };

  const isRecollect = obs.runKind === 'recollect';
  let excludedReason = null;

  if (obs.cancelled) excludedReason = 'cancelled';
  else if (isRecollect && !rule.includeRecollect) excludedReason = 'recollect';
  else if (!obs.valid) excludedReason = 'invalid';
  else if (rule.pausePolicy === 'exclude' && obs.pauseAffected) excludedReason = 'pause';
  else if (
    rule.outlierMax != null &&
    effective.total != null &&
    effective.total > rule.outlierMax
  ) {
    excludedReason = 'outlier';
  }

  return {
    ...obs,
    effective,
    excludedReason,
    included: excludedReason == null
  };
}

function dateInRange(businessDay, filters) {
  if (!businessDay) return false;
  if (filters.dateFrom && businessDay < filters.dateFrom) return false;
  if (filters.dateTo && businessDay > filters.dateTo) return false;
  return true;
}

export function matchesBase(obs, filters) {
  if (!dateInRange(obs.businessDay, filters)) return false;
  if (filters.department && filters.department !== 'all' && obs.department !== filters.department) {
    return false;
  }
  if (filters.shift && filters.shift !== 'all' && obs.shiftId !== filters.shift) return false;
  return true;
}

function isOverdue(obs, rule) {
  return (
    obs.effective.total != null &&
    rule.targets.total != null &&
    obs.effective.total > rule.targets.total
  );
}

function buildReviewEntities(observations) {
  const list = [];
  for (const obs of observations) {
    if (obs.issues.length) {
      list.push({
        entityId: obs.specimenId,
        type: 'primary',
        typeLabel: obs.runKind === 'recollect' ? '重采样本' : '原始样本',
        specimenId: obs.specimenId,
        patientKey: obs.patientKey,
        testId: obs.testId,
        department: obs.department,
        collectedAt: obs.collectedAt,
        businessDay: obs.businessDay,
        shiftId: obs.shiftId,
        shiftName: obs.shiftName,
        issues: obs.issues,
        status: obs.status,
        runKind: obs.runKind
      });
    }
    for (const run of obs.retestRuns) {
      if (run.issues.length) {
        list.push({
          entityId: run.runId,
          type: 'retest',
          typeLabel: '复测轮次',
          specimenId: obs.specimenId,
          runId: run.runId,
          patientKey: obs.patientKey,
          testId: obs.testId,
          department: obs.department,
          collectedAt: run.startedAt ?? obs.collectedAt,
          businessDay: obs.businessDay,
          shiftId: obs.shiftId,
          shiftName: obs.shiftName,
          issues: run.issues,
          status: 'retest'
        });
      }
    }
  }
  return list.sort((a, b) => (b.collectedAt ?? 0) - (a.collectedAt ?? 0));
}

/**
 * 主分析入口。
 * filters 中的日期按业务日（班次开始日）筛选，夜班跨日归前一日。
 */
export function analyze(dataset, filters, ruleset, catalog) {
  const rule = ruleset[filters.testId] || Object.values(ruleset)[0];
  const test = catalog.find(t => t.id === filters.testId) || catalog[0];
  const pauses = dataset.devicePauses.map(p => ({
    ...p,
    start: toMs(p.start),
    end: toMs(p.end)
  }));

  const allObservations = dataset.specimens.map(s => normalizeSpecimen(s, pauses));
  const observations = allObservations
    .filter(o => matchesBase(o, filters) && o.testId === filters.testId)
    .map(o => applyRuleToObservation(o, rule));

  const included = observations.filter(o => o.included);
  const byReason = {
    invalid: observations.filter(o => o.excludedReason === 'invalid').length,
    cancelled: observations.filter(o => o.excludedReason === 'cancelled').length,
    recollect: observations.filter(o => o.excludedReason === 'recollect').length,
    pause: observations.filter(o => o.excludedReason === 'pause').length,
    outlier: observations.filter(o => o.excludedReason === 'outlier').length
  };

  const totals = included.map(o => o.effective.total).filter(isNum);
  const totalStats = stats(totals);
  const overdue = included.filter(o => isOverdue(o, rule));

  // 患者口径：同一患者同一项目多次采样（复查、重采、复测）不应算成多个独立病人。
  // 因此患者集合只由“时间点完整且未取消”的标本决定，不受重采纳入/停机/超限等
  // 均值口径开关影响；每患者取最后一次有效结果作为一次“患者周转”。
  const patientObs = new Map();
  for (const o of observations) {
    if (!o.valid || o.cancelled) continue;
    const key = `${o.patientKey}|${o.testId}`;
    const prev = patientObs.get(key);
    if (!prev || (o.resultedAt ?? 0) > (prev.resultedAt ?? 0)) patientObs.set(key, o);
  }
  const patientTotals = [...patientObs.values()]
    .map(o => o.effective.total)
    .filter(isNum)
    .sort((a, b) => a - b);
  const patientStats = stats(patientTotals);

  const stageStats = {};
  const stageOverTarget = {};
  for (const st of STAGES) {
    const values = included.map(o => o.effective[st.duration]).filter(isNum);
    stageStats[st.key] = stats(values);
    const limit = rule.targets[st.key];
    stageOverTarget[st.key] =
      limit != null
        ? included.filter(o => isNum(o.effective[st.duration]) && o.effective[st.duration] > limit).length
        : null;
  }
  stageStats.total = totalStats;
  // 端到端超时数放在同一字典，避免页面再用另一套口径
  stageOverTarget.total = rule.targets.total != null ? overdue.length : null;

  const review = buildReviewEntities(observations);
  const retestRuns = observations.flatMap(o => o.retestRuns);
  const validRetests = retestRuns.filter(r => r.valid && isNum(r.duration));
  const retestStats = stats(validRetests.map(r => r.duration));

  const recollectSpecimens = observations.filter(o => o.runKind === 'recollect');
  const recollectIncluded = recollectSpecimens.filter(o => o.included);
  const recollectStats = stats(recollectIncluded.map(o => o.effective.total).filter(isNum));

  const cancelledSpecimens = observations.filter(o => o.cancelled);
  const pauseAffected = observations.filter(o => o.pauseAffected);
  const pauseOverlaps = pauseAffected.map(o => o.pauseOverlap).filter(isNum);

  const shifts = SHIFT_ORDER.map(id => {
    const def = DEFAULT_SHIFTS.find(s => s.id === id);
    const list = included.filter(o => o.shiftId === id);
    const stages = {};
    for (const st of STAGES) {
      stages[st.key] = stats(list.map(o => o.effective[st.duration]).filter(isNum));
    }
    stages.total = stats(list.map(o => o.effective.total).filter(isNum));
    const over = list.filter(o => isOverdue(o, rule)).length;
    const pendingHere = review.filter(r => r.shiftId === id).length;
    return {
      id,
      name: def?.name || id,
      short: def?.short || id,
      n: list.length,
      stages,
      overdue: over,
      overdueRate: list.length ? over / list.length : null,
      pending: pendingHere,
      medianTotal: stages.total.median
    };
  });

  const deptNames = [...new Set(allObservations.map(o => o.department))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN')
  );
  const departments = deptNames.map(name => {
    const list = included.filter(o => o.department === name);
    const over = list.filter(o => isOverdue(o, rule)).length;
    return {
      name,
      n: list.length,
      overdue: over,
      overdueRate: list.length ? over / list.length : null,
      medianTotal: stats(list.map(o => o.effective.total).filter(isNum)).median,
      pending: review.filter(r => r.department === name).length
    };
  });

  return {
    test,
    rule,
    observations,
    included,
    review,
    shifts,
    departments,
    stageStats,
    stageOverTarget,
    retestRuns,
    retestStats,
    recollectSpecimens,
    recollectStats,
    cancelledSpecimens,
    pauseAffected,
    pauseStats: stats(pauseOverlaps),
    byReason,
    totals: {
      hit: observations.length,
      included: included.length,
      patients: patientObs.size,
      patientMedian: patientStats.median,
      patientP90: patientStats.p90,
      repeatSampling: included.length - patientObs.size,
      median: totalStats.median,
      mean: totalStats.mean,
      p90: totalStats.p90,
      overdue: overdue.length,
      overdueRate: included.length ? overdue.length / included.length : null,
      pending: review.length,
      retestRuns: retestRuns.length,
      retestSpecimens: observations.filter(o => o.retestRuns.length > 0).length,
      recollect: recollectSpecimens.length,
      cancelled: cancelledSpecimens.length,
      pauseAffected: pauseAffected.length,
      pauseMinutes: Math.round(pauseStatsMinutes(pauseOverlaps))
    },
    patientTotals,
    overdueList: overdue
  };
}

function pauseStatsMinutes(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0);
}

/** 仅返回某项目在相同日期/科室/班次筛选下的摘要，用于项目对比 */
export function analyzeSummaryForTest(dataset, filters, ruleset, catalog, testId) {
  const nextFilters = { ...filters, testId };
  const result = analyze(dataset, nextFilters, ruleset, catalog);
  return {
    testId,
    test: result.test,
    rule: result.rule,
    totals: result.totals
  };
}

/**
 * 规则调整影响预览：同一筛选下，已应用规则 vs 草稿规则。
 * 返回纳入集合的增减、超时增减、中位变化等。
 */
export function previewRuleChange(dataset, filters, appliedRuleset, draftRuleset, catalog) {
  const before = analyze(dataset, filters, appliedRuleset, catalog);
  const after = analyze(dataset, filters, draftRuleset, catalog);

  const beforeIds = new Set(before.included.map(o => o.specimenId));
  const afterIds = new Set(after.included.map(o => o.specimenId));
  const added = after.included.filter(o => !beforeIds.has(o.specimenId));
  const removed = before.included.filter(o => !afterIds.has(o.specimenId));
  const beforeOverdueIds = new Set(before.overdueList.map(o => o.specimenId));
  const afterOverdueIds = new Set(after.overdueList.map(o => o.specimenId));
  const overdueAdded = after.overdueList.filter(o => !beforeOverdueIds.has(o.specimenId));
  const overdueRemoved = before.overdueList.filter(o => !afterOverdueIds.has(o.specimenId));

  return {
    before,
    after,
    added,
    removed,
    overdueAdded,
    overdueRemoved,
    deltas: {
      included: after.totals.included - before.totals.included,
      median:
        after.totals.median != null && before.totals.median != null
          ? after.totals.median - before.totals.median
          : null,
      overdue: after.totals.overdue - before.totals.overdue,
      overdueRate:
        after.totals.overdueRate != null && before.totals.overdueRate != null
          ? after.totals.overdueRate - before.totals.overdueRate
          : null,
      pending: after.totals.pending - before.totals.pending
    }
  };
}

/** 时间点序列，用于样本展开详情 */
export function timelineFor(obs) {
  return [
    { key: 'collectedAt', label: '采样', ts: obs.collectedAt },
    { key: 'receivedAt', label: '接收', ts: obs.receivedAt },
    { key: 'analyzedAt', label: '上机', ts: obs.analyzedAt },
    { key: 'resultedAt', label: '出结果', ts: obs.resultedAt }
  ];
}
