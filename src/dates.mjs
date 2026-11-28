// 日历日工具：业务资料使用 YYYY-MM-DD（服务所在地日历日，含首尾），金额单位为分。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function today() {
  return process.env.APP_DATE && isValidDate(process.env.APP_DATE)
    ? process.env.APP_DATE
    : new Date().toISOString().slice(0, 10);
}

export function nowTs() {
  return new Date().toISOString();
}

export function monthKey(date) {
  return date.slice(0, 7);
}

// 含首尾的日历日天数
export function daysInclusive(start, end) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

export function withinWindow(date, from, until) {
  return (!from || date >= from) && (!until || date <= until);
}

export function rangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

// 跨月服务按实际每日归属拆分：[{ month, days, amountMinor }]
export function splitByMonth(start, end, dailyMinor) {
  const lines = [];
  let cursor = start;
  while (cursor <= end) {
    const month = monthKey(cursor);
    const monthEnd = `${month}-31`;
    const segmentEnd = end < monthEnd ? end : lastDateOfMonth(cursor);
    const days = daysInclusive(cursor, segmentEnd);
    lines.push({ month, days, amountMinor: days * dailyMinor });
    cursor = addDays(segmentEnd, 1);
  }
  return lines;
}

export function addDays(date, delta) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

function lastDateOfMonth(date) {
  const [year, month] = date.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

export function assertDate(value, field) {
  if (!isValidDate(value)) throw new DomainError('VALIDATION', `${field} 必须是 YYYY-MM-DD 日历日`);
}

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
