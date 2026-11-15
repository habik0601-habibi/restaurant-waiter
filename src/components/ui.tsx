import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-stone-300',
  accent: 'bg-saffron-500 text-white hover:bg-saffron-600 disabled:bg-stone-300',
  secondary: 'bg-white text-ink border border-stone-300 hover:bg-stone-50 disabled:text-stone-400',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-stone-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-stone-300',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizing = size === 'sm' ? 'px-3 py-1.5 text-sm' : size === 'lg' ? 'px-5 py-3.5 text-base' : 'px-4 py-2.5 text-sm'
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors ${sizing} ${VARIANT[variant]} ${className}`}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-stone-200 bg-white ${className}`}>{children}</div>
}

export function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    stone: 'bg-stone-100 text-stone-700',
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
    blue: 'bg-sky-100 text-sky-800',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-8 text-stone-500">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

export function Notice({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  const tones = {
    red: 'border-red-200 bg-red-50 text-red-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }
  return <div className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>
}

/** Bottom sheet on phones, centred dialog on wide screens. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-2 text-stone-500 hover:bg-stone-100">
            ✕
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
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-500 bg-amber-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
      {children}
    </span>
  )
}
