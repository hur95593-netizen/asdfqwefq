export type TimeBucket = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older';

export const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  thisMonth: '本月',
  older: '更早',
};

export const BUCKET_ORDER: TimeBucket[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'];

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 以本地时区为准把时间戳归入时间分组。 */
export function bucketOf(ts: number, now = Date.now()): TimeBucket {
  const today = startOfDay(now);
  if (ts >= today) {
    return 'today';
  }
  const yesterday = today - 86400000;
  if (ts >= yesterday) {
    return 'yesterday';
  }
  // 本周：从周一算起
  const dow = (new Date(today).getDay() + 6) % 7;
  const weekStart = today - dow * 86400000;
  if (ts >= weekStart) {
    return 'thisWeek';
  }
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  if (ts >= monthStart) {
    return 'thisMonth';
  }
  return 'older';
}

/** 判断时间戳是否落在筛选范围内。 */
export function inTimeFilter(ts: number, filter: string, now = Date.now()): boolean {
  switch (filter) {
    case 'today':
      return bucketOf(ts, now) === 'today';
    case 'yesterday':
      return bucketOf(ts, now) === 'yesterday';
    case 'week':
      return ['today', 'yesterday', 'thisWeek'].includes(bucketOf(ts, now));
    case 'month':
      return bucketOf(ts, now) !== 'older';
    default:
      return true;
  }
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60000) {
    return '刚刚';
  }
  if (diff < 3600000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  }
  if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)} 小时前`;
  }
  return `${Math.floor(diff / 86400000)} 天前`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
