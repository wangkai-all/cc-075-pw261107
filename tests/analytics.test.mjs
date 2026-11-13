import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseDataset } from '../src/data.js';
import { TEST_CATALOG } from '../src/catalog.js';
import { resolveShift, DEFAULT_SHIFTS, fmtDuration } from '../src/shift.js';
import {
  analyze,
  buildRuleset,
  normalizeSpecimen,
  applyRuleToObservation,
  previewRuleChange,
  percentile,
  stats,
  buildRuleset as build,
  defaultRulesFor
} from '../src/analytics.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/dataset.json', import.meta.url), 'utf8'));
const dataset = parseDataset(raw);

const fullRange = { dateFrom: '2026-10-17', dateTo: '2026-11-12' };
const baseFilters = { ...fullRange, testId: 'cbc', department: 'all', shift: 'all' };
const ruleset = buildRuleset(TEST_CATALOG);
const at = iso => Date.parse(iso);

// ---------- 班次归属 ----------

test('夜班 00–08 归属前一业务日，跨日不拆班', () => {
  const a = resolveShift(at('2026-10-20T01:30:00Z'));
  assert.equal(a.shift.id, 'night');
  assert.equal(a.businessDay, '2026-10-19');

  const b = resolveShift(at('2026-10-20T07:59:00Z'));
  assert.equal(b.businessDay, '2026-10-19');

  const c = resolveShift(at('2026-10-20T08:00:00Z'));
  assert.equal(c.shift.id, 'morning');
  assert.equal(c.businessDay, '2026-10-20');

  const d = resolveShift(at('2026-10-20T00:00:00Z'));
  assert.equal(d.shift.id, 'night');
  assert.equal(d.businessDay, '2026-10-19');
});

test('白班/中班边界左闭右开', () => {
  assert.equal(resolveShift(at('2026-10-20T15:59:00Z')).shift.id, 'morning');
  assert.equal(resolveShift(at('2026-10-20T16:00:00Z')).shift.id, 'evening');
  assert.equal(resolveShift(at('2026-10-20T23:59:00Z')).shift.id, 'evening');
});

// ---------- 统计基础 ----------

test('百分位线性插值', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.9), 10);
  assert.equal(percentile([], 0.5), null);
});

test('统计量不接受负数与 NaN', () => {
  const s = stats([10, 20, -5, NaN, null, 30]);
  assert.equal(s.n, 3);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.median, 20);
});

// ---------- 样本校验 ----------

test('缺少时间戳与顺序异常被标记为非有效', () => {
  const obs = normalizeSpecimen({
    specimenId: 'X1',
    patientKey: 'P1',
    testId: 'cbc',
    department: '内科',
    collectedAt: at('2026-10-20T09:00:00Z'),
    receivedAt: at('2026-10-20T09:10:00Z'),
    analyzedAt: at('2026-10-20T09:05:00Z'), // 早于接收
    resultedAt: at('2026-10-20T09:40:00Z'),
    status: 'reported',
    runKind: 'original',
    retestRuns: []
  });
  assert.equal(obs.valid, false);
  assert.ok(obs.issues.some(i => i.code === 'order'));

  const missing = normalizeSpecimen({
    specimenId: 'X2',
    patientKey: 'P2',
    testId: 'cbc',
    department: '内科',
    collectedAt: at('2026-10-20T09:00:00Z'),
    receivedAt: at('2026-10-20T09:10:00Z'),
    analyzedAt: null,
    resultedAt: at('2026-10-20T09:40:00Z'),
    status: 'reported',
    runKind: 'original',
    retestRuns: []
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some(i => i.code === 'missing'));
});

test('待核对记录不进入均值、中位与超时率', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const invalid = result.observations.filter(o => !o.valid);
  assert.ok(invalid.length > 0, 'dataset should contain invalid records');
  for (const o of invalid) {
    assert.equal(o.included, false);
    assert.equal(o.excludedReason, 'invalid');
  }
  assert.equal(result.byReason.invalid, invalid.length);
  assert.equal(
    result.included.length + result.byReason.invalid + result.byReason.cancelled +
      result.byReason.recollect + result.byReason.pause + result.byReason.outlier,
    result.observations.length,
    '每个命中样本必须恰好落在一个口径里'
  );
  assert.ok(result.review.length >= invalid.length, '待核对列表应包含无效记录');
});

test('缺少任何时间点的记录都不会贡献时长', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  for (const o of result.included) {
    assert.equal(o.issues.length, 0);
    assert.ok(o.effective.total == null || o.effective.total > 0);
  }
});

// ---------- 患者口径 ----------

test('复测与重采不重复计患者：患者数 ≤ 纳入标本数', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  assert.ok(result.totals.patients <= result.totals.included);
  assert.equal(result.totals.repeatSampling, result.totals.included - result.totals.patients);
  // 患者中位只基于每个 患者×项目 的最后一次结果
  assert.equal(result.patientTotals.length, result.totals.patients);
  for (const v of result.patientTotals) assert.ok(v > 0);
});

test('同一患者多次采样只产生一个患者周转', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const patientKeys = new Set();
  const specimenCounts = new Map();
  for (const o of result.included) {
    const key = `${o.patientKey}|${o.testId}`;
    patientKeys.add(key);
    specimenCounts.set(key, (specimenCounts.get(key) || 0) + 1);
  }
  // 患者集合取所有有效未取消标本，而不仅是纳入均值的标本
  const expectedPatients = new Set(
    result.observations.filter(o => o.valid && !o.cancelled).map(o => `${o.patientKey}|${o.testId}`)
  );
  assert.equal(result.totals.patients, expectedPatients.size);
  assert.ok(result.totals.patients >= patientKeys.size);
  // 有患者出现多次采样，这些不会额外计为患者
  assert.ok([...specimenCounts.values()].some(n => n > 1));
});

test('复测轮次单独统计，不进入患者数', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  assert.ok(result.totals.retestRuns > 0);
  const expectedPatients = new Set(
    result.observations.filter(o => o.valid && !o.cancelled).map(o => `${o.patientKey}|${o.testId}`)
  );
  assert.equal(result.totals.patients, expectedPatients.size);
  // 复测不新增标本键，只是标本内的轮次
  const knownSpecimens = new Set(result.observations.map(o => o.specimenId));
  for (const run of result.retestRuns) {
    assert.match(run.runId, /-R\d+$/);
    assert.ok(run.runId.startsWith(run.specimenId));
    assert.ok(knownSpecimens.has(run.specimenId), '复测必须挂在一份已知标本上');
  }
});

// ---------- 重采与取消 ----------

test('重采默认排除出均值，但可配置为计入，患者数不随之变化', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  assert.ok(result.totals.recollect > 0, 'dataset should contain recollects');
  const ruled = result.recollectSpecimens.filter(o => o.included);
  assert.equal(ruled.length, 0);
  assert.equal(result.byReason.recollect, result.totals.recollect);

  const include = buildRuleset(TEST_CATALOG, { cbc: { includeRecollect: true } });
  const result2 = analyze(dataset, baseFilters, include, TEST_CATALOG);
  assert.ok(result2.recollectSpecimens.filter(o => o.included).length > 0);
  assert.equal(result2.byReason.recollect, 0);
  // 患者口径独立于均值口径：计入重采不新增独立患者
  assert.equal(result2.totals.patients, result.totals.patients);
  assert.ok(result2.totals.included > result.totals.included);
});

test('取消标本不进入均值，也不进入超时', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  assert.ok(result.totals.cancelled > 0);
  for (const o of result.cancelledSpecimens) {
    assert.equal(o.included, false);
    assert.equal(o.excludedReason, 'cancelled');
  }
  assert.ok(result.totals.included > 0);
});

// ---------- 设备停机 ----------

test('停机规则三种口径分开统计', () => {
  const mark = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  assert.equal(mark.rule.pausePolicy, 'mark');
  assert.ok(mark.totals.pauseAffected > 0, 'cbc has samples overlapping device pause');
  const affected = mark.pauseAffected;
  assert.ok(affected.every(o => o.pauseOverlap > 0));
  const includedAffected = affected.filter(o => o.included);
  assert.ok(includedAffected.length > 0, 'mark 口径下未取消的受影响样本仍纳入');
  // 被取消的受影响样本仍按取消口径处理，不会因停机变成纳入
  for (const o of affected) {
    if (o.cancelled) assert.equal(o.excludedReason, 'cancelled');
  }

  const deductRules = buildRuleset(TEST_CATALOG, { cbc: { pausePolicy: 'deduct' } });
  const deduct = analyze(dataset, baseFilters, deductRules, TEST_CATALOG);
  assert.equal(deduct.rule.pausePolicy, 'deduct');
  assert.equal(deduct.totals.included, mark.totals.included, '扣除口径不改变纳入集合');
  for (const o of deduct.pauseAffected.filter(x => x.included)) {
    const marked = mark.included.find(m => m.specimenId === o.specimenId);
    assert.ok(o.effective.total < marked.effective.total, '停机重叠被扣除');
    // 只扣接收→上机，其它阶段不变
    assert.equal(o.effective.collectToReceive, marked.effective.collectToReceive);
    assert.equal(o.effective.analyzeToResult, marked.effective.analyzeToResult);
  }

  const excludeRules = buildRuleset(TEST_CATALOG, { cbc: { pausePolicy: 'exclude' } });
  const exclude = analyze(dataset, baseFilters, excludeRules, TEST_CATALOG);
  // 只影响那些在 mark 口径下本来被纳入的样本
  assert.equal(exclude.totals.included, mark.totals.included - includedAffected.length);
  assert.equal(exclude.byReason.pause, includedAffected.length);
});

test('停机扣除不会把等待时长算成负数', () => {
  const rules = buildRuleset(TEST_CATALOG, { cbc: { pausePolicy: 'deduct' } });
  const result = analyze(dataset, baseFilters, rules, TEST_CATALOG);
  for (const o of result.included) {
    assert.ok(o.effective.receiveToAnalyze >= 0);
    assert.ok(o.effective.total >= 0);
  }
});

// ---------- 超时与目标 ----------

test('超时只由有效纳入样本产生，且阈值按项目目标', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const target = result.rule.targets.total;
  for (const o of result.overdueList) {
    assert.ok(o.included);
    assert.ok(o.effective.total > target);
  }
  const over = result.included.filter(o => o.effective.total > target);
  assert.equal(over.length, result.totals.overdue);
});

test('每个阶段超时计数与目标一致', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const durationForKey = {
    sampleToReceive: 'collectToReceive',
    receiveToAnalyze: 'receiveToAnalyze',
    analyzeToResult: 'analyzeToResult',
    total: 'total'
  };
  for (const [key, count] of Object.entries(result.stageOverTarget)) {
    const field = durationForKey[key];
    const limit = ruleset.cbc.targets[key];
    if (count == null) {
      assert.equal(limit, null, `${key} 目标为空时不应有计数`);
      continue;
    }
    const expected = result.included.filter(o => o.effective[field] > limit).length;
    assert.equal(count, expected, `${key} 超时计数`);
  }
  assert.equal(result.stageOverTarget.total, result.totals.overdue);
});

// ---------- 规则预览 ----------

test('规则预览的纳入/超时增减与实际应用一致', () => {
  const filters = baseFilters;
  const strict = buildRuleset(TEST_CATALOG, { cbc: { targets: { total: 40 } } });
  const diff = previewRuleChange(dataset, filters, ruleset, strict, TEST_CATALOG);
  const applied = analyze(dataset, filters, strict, TEST_CATALOG);
  assert.equal(diff.after.totals.overdue, applied.totals.overdue);
  assert.equal(diff.deltas.overdue, applied.totals.overdue - diff.before.totals.overdue);
  assert.equal(diff.added.length - diff.removed.length, diff.deltas.included);
  // 只调目标：纳入集合不变
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.ok(diff.overdueAdded.length > 0);
  for (const o of diff.overdueAdded) {
    assert.ok(o.effective.total > 40);
    assert.ok(!diff.before.overdueList.some(b => b.specimenId === o.specimenId));
  }
});

test('极端值规则只排除超限样本且改变均值集合', () => {
  const rules = buildRuleset(TEST_CATALOG, { cbc: { outlierMax: 120 } });
  const result = analyze(dataset, baseFilters, rules, TEST_CATALOG);
  assert.ok(result.byReason.outlier > 0);
  for (const o of result.observations) {
    if (o.excludedReason === 'outlier') {
      assert.ok(o.effective.total > 120);
      assert.equal(o.included, false);
    }
  }
  assert.ok(result.totals.median < analyze(dataset, baseFilters, ruleset, TEST_CATALOG).totals.median);
});

test('调整目标后受影响数量可计算，且待核对集合不变', () => {
  const loose = buildRuleset(TEST_CATALOG, { cbc: { targets: { total: 9999 } } });
  const diff = previewRuleChange(dataset, baseFilters, ruleset, loose, TEST_CATALOG);
  assert.equal(diff.deltas.pending, 0);
  assert.equal(diff.after.review.length, diff.before.review.length);
  assert.equal(diff.after.totals.overdue, 0);
});

// ---------- 筛选与班次聚合 ----------

test('科室/班次聚合与纳入集合自洽', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const sumShift = result.shifts.reduce((a, s) => a + s.n, 0);
  const sumDept = result.departments.reduce((a, d) => a + d.n, 0);
  assert.equal(sumShift, result.totals.included);
  assert.equal(sumDept, result.totals.included);
  const sumOver = result.shifts.reduce((a, s) => a + s.overdue, 0);
  assert.equal(sumOver, result.totals.overdue);
});

test('班次筛选与夜班归属自洽', () => {
  const all = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  const night = analyze(dataset, { ...baseFilters, shift: 'night' }, ruleset, TEST_CATALOG);
  for (const o of night.included) {
    assert.equal(o.shiftId, 'night');
    assert.equal(night.totals.pending >= 0, true);
  }
  assert.ok(night.included.length < all.included.length);
  // 夜班样本的采样小时落在 0–8
  for (const o of night.included) {
    const h = new Date(o.collectedAt).getUTCHours();
    assert.ok(h >= 0 && h < 8);
  }
});

test('日期筛选按业务日：夜班 00–08 不会漏到次日', () => {
  const day = '2026-10-20';
  const f = { ...baseFilters, dateFrom: day, dateTo: day };
  const result = analyze(dataset, f, ruleset, TEST_CATALOG);
  for (const o of result.observations) {
    const resolved = resolveShift(o.collectedAt);
    assert.equal(resolved.businessDay, day);
    if (o.shiftId === 'night') {
      assert.equal(new Date(o.collectedAt).toISOString().slice(0, 10), '2026-10-21');
    }
  }
});

test('空筛选结果不产生 NaN 或崩溃', () => {
  const f = { ...baseFilters, dateFrom: '1990-01-01', dateTo: '1990-01-02' };
  const result = analyze(dataset, f, ruleset, TEST_CATALOG);
  assert.equal(result.totals.included, 0);
  assert.equal(result.totals.median, null);
  assert.equal(result.totals.overdueRate, null);
  assert.equal(result.totals.patients, 0);
  for (const s of result.shifts) assert.equal(s.medianTotal, null);
});

// ---------- 数据本身 ----------

test('数据集不含真实个人信息字段', () => {
  const forbidden = ['name', 'realName', 'idCard', 'phone', 'address', 'birthDate'];
  const keys = new Set(Object.keys(raw.specimens[0]));
  for (const f of forbidden) assert.equal(keys.has(f), false, `不应有字段 ${f}`);
  assert.equal(raw.meta.synthetic, true);
  // 患者键必须是匿名编号格式
  for (const s of raw.specimens) {
    assert.match(s.patientKey, /^P-\d{2}-\d{4}$/);
  }
});

test('取消样本带有原因，复测/重采关系可追溯', () => {
  for (const s of raw.specimens) {
    if (s.status === 'cancelled') assert.ok(s.cancelReason);
    if (s.runKind === 'recollect') assert.ok(s.recollectOf);
    for (const r of s.retestRuns) assert.ok(r.runId);
  }
});

test('数据顺序合理：正常样本时间戳单调递增', () => {
  const result = analyze(dataset, baseFilters, ruleset, TEST_CATALOG);
  for (const o of result.included) {
    assert.ok(o.collectedAt <= o.receivedAt);
    assert.ok(o.receivedAt <= o.analyzedAt);
    assert.ok(o.analyzedAt <= o.resultedAt);
  }
});
