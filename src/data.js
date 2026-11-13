// 读取并解析虚构数据集（ISO 字符串 → 毫秒时间戳）。
import { TEST_CATALOG } from './catalog.js';

const TIMESTAMP_FIELDS = ['collectedAt', 'receivedAt', 'analyzedAt', 'resultedAt', 'cancelledAt'];

export function parseDataset(raw) {
  const parse = v => (v == null ? null : Date.parse(v));
  return {
    meta: raw.meta,
    departments: raw.departments,
    devicePauses: (raw.devicePauses || []).map(p => ({
      ...p,
      start: Date.parse(p.start),
      end: Date.parse(p.end)
    })),
    specimens: raw.specimens.map(s => {
      const out = { ...s };
      for (const f of TIMESTAMP_FIELDS) out[f] = parse(s[f]);
      out.retestRuns = (s.retestRuns || []).map(r => ({
        ...r,
        startedAt: parse(r.startedAt),
        resultedAt: parse(r.resultedAt)
      }));
      return out;
    })
  };
}

export async function loadDataset(url = './data/dataset.json') {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法加载数据 (${res.status})`);
  return parseDataset(await res.json());
}

/** 数据日期范围（按业务日） */
export function datasetRange(dataset) {
  const days = dataset.specimens
    .map(s => (s.collectedAt == null ? null : new Date(s.collectedAt).toISOString().slice(0, 10)))
    .filter(Boolean)
    .sort();
  return { from: days[0], to: days[days.length - 1] };
}

export { TEST_CATALOG };
