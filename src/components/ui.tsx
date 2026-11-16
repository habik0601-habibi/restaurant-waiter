import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-700 disabled:bg-stone-300 disabled:shadow-none',
  accent: 'bg-saffron-500 text-coal shadow-sm hover:bg-saffron-400 disabled:bg-stone-300 disabled:text-white disabled:shadow-none',
  secondary: 'bg-paper text-ink border border-stone-300 hover:border-stone-400 hover:bg-stone-50 disabled:text-stone-400',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-stone-400',
  danger: 'bg-red-700 text-white shadow-sm hover:bg-red-800 disabled:bg-stone-300 disabled:shadow-none',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizing = size === 'sm' ? 'min-h-9 px-3 py-1.5 text-sm' : size === 'lg' ? 'min-h-13 px-5 py-3.5 text-base' : 'min-h-11 px-4 py-2.5 text-sm'
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-tight ${sizing} ${VARIANT[variant]} ${className}`}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-stone-200/80 bg-paper shadow-card ${className}`}>{children}</div>
}

export function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    stone: 'bg-stone-100 text-stone-700 ring-stone-200',
    green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    amber: 'bg-saffron-100 text-saffron-600 ring-saffron-400/40',
    red: 'bg-red-50 text-red-700 ring-red-200',
    blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${tones[tone]}`}>{children}</span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-8 text-stone-600" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

export function Notice({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  const tones = {
    red: 'border-red-200 bg-red-50 text-red-800',
    amber: 'border-saffron-400/50 bg-saffron-100 text-saffron-600',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${tones[tone]}`} role={tone === 'red' ? 'alert' : 'status'}>
      <Icon name={tone === 'green' ? 'check' : 'alert'} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Bottom sheet on phones, centred dialog on wide screens. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-coal/55 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-paper p-5 pb-8 shadow-float sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-300 sm:hidden" />
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full text-stone-600 hover:bg-stone-100">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Marks anything that is not real: sample data, simulated payments. */
export function Simulated({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-saffron-500 bg-saffron-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-saffron-600">
      {children}
    </span>
  )
}

/** Round plus/minus control with a 44px touch target. */
export function Stepper({ value, onChange, min = 1, max = 20, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  const btn = 'flex h-11 w-11 items-center justify-center rounded-full border border-stone-300 bg-paper text-ink hover:border-brand-500 hover:text-brand-700 disabled:opacity-40'
  return (
    <div className="flex items-center gap-3">
      <button type="button" className={btn} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} aria-label={`Fewer ${label}`}>
        <Icon name="minus" />
      </button>
      <span className="w-6 text-center text-lg font-bold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" className={btn} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} aria-label={`More ${label}`}>
        <Icon name="plus" />
      </button>
    </div>
  )
}

/** Dark hero band with the animated ember backdrop behind it. */
export function Hero({ eyebrow, title, children, backdrop }: { eyebrow?: string; title: string; children?: ReactNode; backdrop: ReactNode }) {
  return (
    <header className="relative isolate overflow-hidden bg-brand-900 text-white">
      {backdrop}
      <div className="relative px-5 pb-9 pt-8">
        {eyebrow && <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-saffron-400">{eyebrow}</p>}
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight">{title}</h1>
        <div className="ember-rule mt-2.5" />
        {children}
      </div>
    </header>
  )
}
