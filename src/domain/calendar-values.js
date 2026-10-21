import { isRequestId } from './request.js';

export const RESERVATION_PHASE=Object.freeze({ PROVISIONAL: 'provisional',FINAL: 'final' });
const PHASES=new Set(Object.values(RESERVATION_PHASE));
export function isReservationPhase(value) { return PHASES.has(value); }
export function isCalendarRoomId(value) { return isRequestId(value); }
export function isIdempotencyKey(value) { return typeof value==='string' && /^[0-9a-f]{64}$/.test(value); }
