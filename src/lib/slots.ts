/**
 * Reservation time slots, computed in the RESTAURANT's time zone.
 *
 * The browser's own time zone is irrelevant: a guest travelling, or a laptop
 * set to the wrong zone, must still be offered "later today" as the
 * restaurant sees it, because that is what the database checks
 * (create_reservation compares dates in the branch time zone).
 */

const HALF_HOUR = 30 * 60_000

/** Offset in ms between UTC and the given zone at the given instant. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** Hour of day (0-23) in the zone. */
export function hourIn(instant: number, timeZone: string): number {
  return new Date(instant + zoneOffset(instant, timeZone)).getUTCHours()
}

/**
 * ISO timestamps of every half hour after `now`, up to and including `lastHour`:00
 * of the same calendar day in the restaurant's zone.
 */
export function todaySlots(now: number, timeZone = 'Asia/Karachi', lastHour = 23): string[] {
  const offset = zoneOffset(now, timeZone)
  const local = now + offset // "wall clock" as a UTC number
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000
  const end = dayStart + lastHour * 3_600_000
  let t = Math.floor(local / HALF_HOUR) * HALF_HOUR + HALF_HOUR
  const out: string[] = []
  while (t <= end) {
    out.push(new Date(t - offset).toISOString())
    t += HALF_HOUR
  }
  return out
}

/** "8:00 pm" in the restaurant's zone. */
export function slotLabel(iso: string, timeZone = 'Asia/Karachi'): string {
  return new Date(iso).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit', timeZone })
}
