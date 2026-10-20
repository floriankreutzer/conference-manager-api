const LOCAL_BASELINE_DAY = Date.UTC(2026, 5, 15);
const DAY_MS = 24 * 60 * 60 * 1000;
const BERLIN_SUMMER_OFFSET_MS = 2 * 60 * 60 * 1000;

function localInstant(day, hour, minute, timeZone) {
  const target = day + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  let result = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(result))
      .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    result += target - shown;
  }
  return new Date(result).toISOString();
}

// Only dates change; this function supplies no runtime or identity authority.
export function scheduleSyntheticBusinessRequests(tenants, now) {
  if (!Array.isArray(tenants) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('SYNTHETIC_BUSINESS_CLOCK_INVALID');
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilMonday = ((8 - new Date(today).getUTCDay()) % 7) || 7;
  const monday = today + daysUntilMonday * DAY_MS;
  const generation = structuredClone(tenants);
  for (const tenant of generation) {
    for (const request of tenant.requests) {
      const baselineLocalStart = Date.parse(request.startsAt) + BERLIN_SUMMER_OFFSET_MS;
      const baselineLocalDay = Math.floor(baselineLocalStart / DAY_MS) * DAY_MS;
      const dayOffset = (baselineLocalDay - LOCAL_BASELINE_DAY) / DAY_MS;
      const minuteOfDay = (baselineLocalStart - baselineLocalDay) / (60 * 1000);
      const location = tenant.settings.locations.find(({ rooms }) => (
        rooms.some(({ id }) => id === request.roomId)
      ));
      const duration = Date.parse(request.endsAt) - Date.parse(request.startsAt);
      request.startsAt = localInstant(
        monday + dayOffset * DAY_MS,
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
        location.timeZone,
      );
      request.endsAt = new Date(Date.parse(request.startsAt) + duration).toISOString();
    }
  }
  return generation;
}
