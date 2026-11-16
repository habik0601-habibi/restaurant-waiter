import { describe, expect, it } from 'vitest'
import { hourIn, slotLabel, todaySlots } from './slots'

// 2026-11-16 03:35 in Karachi (UTC+5) = 2026-11-15 22:35 UTC
const NOW = Date.UTC(2026, 10, 15, 22, 35)

describe('reservation slots in the restaurant time zone', () => {
  it('starts at the next half hour in Karachi time', () => {
    const slots = todaySlots(NOW, 'Asia/Karachi')
    expect(slotLabel(slots[0], 'Asia/Karachi')).toBe('4:00 am')
    expect(slotLabel(slots[slots.length - 1], 'Asia/Karachi')).toBe('11:00 pm')
  })

  it('gives the same slots whatever zone the browser is in', () => {
    const a = todaySlots(NOW, 'Asia/Karachi')
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    const b = todaySlots(NOW, 'Asia/Karachi')
    process.env.TZ = original
    expect(b).toEqual(a)
  })

  it('never offers a slot that is not on the restaurant\'s calendar day', () => {
    for (const s of todaySlots(NOW, 'Asia/Karachi')) {
      expect(new Date(s).getTime() + 5 * 3_600_000).toBeLessThan(Date.UTC(2026, 10, 17))
      expect(new Date(s).getTime() + 5 * 3_600_000).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 16))
    }
  })

  it('offers nothing after the last hour', () => {
    const late = Date.UTC(2026, 10, 16, 18, 10) // 23:10 in Karachi
    expect(todaySlots(late, 'Asia/Karachi')).toEqual([])
  })

  it('handles a zone with a half-hour offset', () => {
    const slots = todaySlots(Date.UTC(2026, 10, 16, 6, 40), 'Asia/Kolkata') // 12:10 in India
    expect(slotLabel(slots[0], 'Asia/Kolkata')).toBe('12:30 pm')
  })

  it('reads the hour in a zone', () => {
    expect(hourIn(NOW, 'Asia/Karachi')).toBe(3)
    expect(hourIn(NOW, 'UTC')).toBe(22)
  })
})
