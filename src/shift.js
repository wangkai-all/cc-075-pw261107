// 班次归属：夜班跨日按实际班次计算。
// 班次定义（可配置）：
//   白班 morning  08:00–16:00
//   中班 evening  16:00–24:00
//   夜班 night    00:00–08:00  ← 跨日班次：归属到前一日的工作日
// 业务日 (business day) = 班次开始那天。夜班 00:00–08:00 的采样属于前一天。

export const DEFAULT_SHIFTS = [
  { id: 'morning', name: '白班', short: '白', start: 8 * 60, end: 16 * 60, crossesMidnight: false },
  { id: 'evening', name: '中班', short: '中', start: 16 * 60, end: 24 * 60, crossesMidnight: false },
  { id: 'night', name: '夜班', short: '夜', start: 0, end: 8 * 60, crossesMidnight: true }
];

// 便于阅读表格时使用固定顺序
export const SHIFT_ORDER = ['morning', 'evening', 'night'];

/** 分钟数 → "YYYY-MM-DD"（使用 UTC，避免时区误差） */
export function dayKey(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

/**
 * 从班次定义生成区间。end 允许 1440 表示 24:00。
 * 返回 {start, end} 毫秒时间戳，end 可能落在次日。
 */
export function shiftWindow(dayKeyStr, shift) {
  const startMs = Date.parse(dayKeyStr + 'T00:00:00Z') + shift.start * 60000;
  let endMs = Date.parse(dayKeyStr + 'T00:00:00Z') + shift.end * 60000;
  return { start: startMs, end: endMs };
}

/**
 * 判断时间戳属于哪个班次、哪个业务日。
 * 夜班 (crossesMidnight) 的 00:00–08:00 归到前一天。
 * 边界规则：包含 start，排除 end（左闭右开）。
 */
export function resolveShift(ts, shifts = DEFAULT_SHIFTS) {
  const d = new Date(ts);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  for (const s of shifts) {
    const inRange = s.start <= s.end
      ? minutes >= s.start && minutes < s.end
      : minutes >= s.start || minutes < s.end;
    if (!inRange) continue;
    const ownDay = dayKey(ts);
    const businessDay = s.crossesMidnight && minutes < s.end
      ? dayKey(Date.parse(ownDay + 'T00:00:00Z') - 86400000)
      : ownDay;
    return { shift: s, businessDay };
  }
  // 覆盖不到（班次配置有缺口）时，归到最近的、按 24h 兜底
  return { shift: shifts[0], businessDay: dayKey(ts), unassigned: true };
}

/** 显示用时：返回 {value, unit, text}。页面与表格共用。 */
export function fmtDuration(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)} 分`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/**
 * 轴标签：同一根轴只用一个单位，从 0 读到最大值时不混用 m/h。
 * 短轴（<4 小时）整根轴用分钟，长轴整根轴用小时，使 0 与满刻度读起来一致。
 */
export function axisFormatter(domainMinutes) {
  const useHours = (domainMinutes ?? 0) >= 240;
  return minutes => {
    if (minutes == null || Number.isNaN(minutes)) return '—';
    if (!useHours) {
      const m = Math.round(minutes * 10) / 10;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}分`;
    }
    const h = Math.round((minutes / 60) * 10) / 10;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  };
}

/** 具体时刻，本地化到 UTC 以便确定性 */
export function fmtTime(ts, opts = {}) {
  if (ts == null) return '—';
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (opts.withDate) return `${dayKey(ts)} ${hh}:${mm}`;
  return `${hh}:${mm}`;
}

export function fmtDate(ts) {
  return dayKey(ts);
}
