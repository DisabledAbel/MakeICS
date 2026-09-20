import { createHash } from 'node:crypto';

export function escapeIcsText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export function formatIcsUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function foldIcsLine(line, { keepTogether = [] } = {}) {
  const chunks = [];
  let remaining = line;
  while (Buffer.byteLength(remaining, 'utf8') > 75) {
    let bytes = 0;
    let end = 0;
    for (const codePoint of remaining) {
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
      if (bytes + codePointBytes > 75) break;
      bytes += codePointBytes;
      end += codePoint.length;
    }

    for (const text of keepTogether) {
      const start = remaining.indexOf(text);
      if (start > 0 && start < end && start + text.length > end && Buffer.byteLength(` ${text}`, 'utf8') <= 75) {
        end = start;
        break;
      }
    }

    chunks.push(remaining.slice(0, end));
    remaining = ` ${remaining.slice(end)}`;
  }
  chunks.push(remaining);
  return chunks.join('\r\n');
}

export function normalizeEventStatus(value) {
  const status = String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (['CANCELLED', 'CANCELED', 'ABANDONED'].includes(status)) return 'CANCELLED';
  if (['TENTATIVE', 'POSTPONED', 'PPD', 'SUSPENDED', 'DELAYED', 'TBD'].includes(status)) return 'TENTATIVE';
  return 'CONFIRMED';
}

export function normalizeLastModified(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function sequenceFromLastModified(value) {
  const normalized = normalizeLastModified(value);
  return normalized ? Math.max(0, Math.floor(new Date(normalized).getTime() / 1000)) : 0;
}

function fingerprintValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value ?? null;
}

export function createEventFingerprint(event) {
  const broadcast = event.broadcast ?? event.tvStation ?? event.metadata?.broadcast ?? event.metadata?.network ?? null;
  const material = {
    title: fingerprintValue(event.title ?? event.name),
    start: fingerprintValue(event.start),
    end: fingerprintValue(event.end),
    allDay: Boolean(event.allDay),
    location: fingerprintValue(event.location ?? event.venue),
    status: normalizeEventStatus(event.status),
    broadcast: fingerprintValue(broadcast)
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
