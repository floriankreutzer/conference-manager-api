const IANA_TIME_ZONE = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const TIME_ZONE_MAX_LENGTH = 64;

export function isIanaTimeZone(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > TIME_ZONE_MAX_LENGTH
    || !IANA_TIME_ZONE.test(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
