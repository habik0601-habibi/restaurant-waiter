import { describe, expect, it } from 'vitest'
import {
  TABLE_STATES,
  TRANSITIONS,
  applyEvent,
  canTransition,
  isOverdue,
  nextStates,
  type TableState,
} from './tableStateMachine'

describe('table state machine', () => {
  it('walks the normal life of a table', () => {
    let s: TableState = 'free'
    s = applyEvent(s, 'seat')
    expect(s).toBe('seated')
    s = applyEvent(s, 'order_placed')
    expect(s).toBe('ordered')
    s = applyEvent(s, 'order_served')
    expect(s).toBe('eating')
    s = applyEvent(s, 'bill_requested')
    expect(s).toBe('bill_requested')
    s = applyEvent(s, 'paid')
    expect(s).toBe('paid_dirty')
    s = applyEvent(s, 'cleared')
    expect(s).toBe('free')
  })

  it('allows a second round of ordering while eating', () => {
    expect(applyEvent('eating', 'order_placed')).toBe('ordered')
  })

  it('rejects illegal jumps', () => {
    expect(canTransition('free', 'ordered')).toBe(false) // cannot order at an unseated table
    expect(canTransition('free', 'eating')).toBe(false)
    expect(canTransition('seated', 'bill_requested')).toBe(false) // nothing to pay for yet
    expect(canTransition('bill_requested', 'ordered')).toBe(false) // no ordering after the bill
    expect(canTransition('paid_dirty', 'seated')).toBe(false) // must be cleared first
    expect(canTransition('ordered', 'free')).toBe(false) // cannot vanish with food on the way
    expect(() => applyEvent('free', 'paid')).toThrow(/invalid_transition/)
    expect(() => applyEvent('paid_dirty', 'order_placed')).toThrow(/invalid_transition/)
  })

  it('has no self-transitions and no duplicates', () => {
    const seen = new Set<string>()
    for (const t of TRANSITIONS) {
      expect(t.from).not.toBe(t.to)
      const key = `${t.from}>${t.to}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('an event never leads to two different states from the same state', () => {
    const seen = new Map<string, string>()
    for (const t of TRANSITIONS) {
      const key = `${t.from}:${t.event}`
      expect(seen.has(key)).toBe(false)
      seen.set(key, t.to)
    }
  })

  it('every state can be left, and every state can get back to free', () => {
    for (const start of TABLE_STATES) {
      if (start !== 'free') expect(nextStates(start).length).toBeGreaterThan(0)
      const reached = new Set<TableState>([start])
      const queue: TableState[] = [start]
      while (queue.length) {
        for (const n of nextStates(queue.shift()!)) {
          if (!reached.has(n)) {
            reached.add(n)
            queue.push(n)
          }
        }
      }
      expect(reached.has('free')).toBe(true)
    }
  })

  it('the only way into free is clearing a paid table or guests leaving before ordering', () => {
    const intoFree = TRANSITIONS.filter((t) => t.to === 'free').map((t) => t.from).sort()
    expect(intoFree).toEqual(['paid_dirty', 'seated'])
  })
})

describe('overdue flag', () => {
  const t0 = new Date('2026-01-01T12:00:00Z').getTime()

  it('flags a table that has sat in one state past its limit', () => {
    expect(isOverdue('seated', t0, t0 + 9 * 60_000, { seated: 10 })).toBe(false)
    expect(isOverdue('seated', t0, t0 + 11 * 60_000, { seated: 10 })).toBe(true)
  })

  it('never flags a state without a limit', () => {
    expect(isOverdue('free', t0, t0 + 24 * 3600_000, { seated: 10 })).toBe(false)
  })

  it('respects a configured limit over the default', () => {
    expect(isOverdue('eating', t0, t0 + 30 * 60_000)).toBe(false)
    expect(isOverdue('eating', t0, t0 + 30 * 60_000, { eating: 20 })).toBe(true)
  })
})
