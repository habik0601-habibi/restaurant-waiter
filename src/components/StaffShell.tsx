import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { staffDb } from '../lib/supabase'
import { friendly } from '../lib/format'
import { EmberBackdrop } from './EmberBackdrop'
import { Button, Notice, Spinner } from './ui'

export interface StaffMember {
  user_id: string
  branch_id: string
  role: 'owner' | 'manager' | 'waiter' | 'kitchen'
  display_name: string
}

const StaffContext = createContext<StaffMember | null>(null)

/** The signed-in staff member. Only valid inside <StaffShell>. */
export function useStaff(): StaffMember {
  const s = useContext(StaffContext)
  if (!s) throw new Error('useStaff must be used inside StaffShell')
  return s
}

const NAV: { to: string; label: string; roles?: StaffMember['role'][] }[] = [
  { to: '/staff', label: 'Floor' },
  { to: '/staff/kitchen', label: 'Kitchen' },
  { to: '/staff/waitlist', label: 'Waitlist' },
  { to: '/staff/qr', label: 'QR codes' },
  { to: '/owner', label: 'Dashboard', roles: ['owner', 'manager'] },
  { to: '/owner/menu', label: 'Menu', roles: ['owner', 'manager'] },
]

/**
 * Login gate and navigation for every staff and owner screen.
 * `managerOnly` screens show a refusal to waiters and kitchen staff; the
 * database enforces the same rule, this is only for a clear message.
 */
export function StaffShell({ children, managerOnly = false, wide = false }: { children: ReactNode; managerOnly?: boolean; wide?: boolean }) {
  const [member, setMember] = useState<StaffMember | null | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    const { data } = await staffDb.auth.getSession()
    if (!data.session) return setMember(null)
    const { data: row } = await staffDb.from('staff_members').select('*').eq('user_id', data.session.user.id).maybeSingle()
    setMember((row as StaffMember | null) ?? null)
    if (!row) setError('This account is not a staff member of any branch.')
  }

  useEffect(() => {
    void load()
  }, [])

  async function signIn(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await staffDb.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(friendly(error))
    else await load()
    setBusy(false)
  }

  async function signOut() {
    await staffDb.auth.signOut()
    setMember(null)
  }

  if (member === undefined) return <Spinner label="Checking login" />

  if (member === null) {
    return (
      <div className="relative isolate flex min-h-full items-center justify-center overflow-hidden bg-brand-900 p-4">
        <EmberBackdrop />
        <form onSubmit={signIn} className="relative w-full max-w-sm space-y-4 rounded-3xl bg-paper p-7 shadow-float">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-brand-600">Zaiqa Karahi House</p>
            <h1 className="mt-1 text-3xl font-bold">Staff login</h1>
            <p className="mt-1 text-sm text-stone-600">Floor, kitchen and owner screens.</p>
          </div>
          {error && <Notice>{error}</Notice>}
          <label className="block text-sm font-medium">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5"
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5"
            />
          </label>
          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    )
  }

  const allowed = !managerOnly || member.role === 'owner' || member.role === 'manager'

  return (
    <StaffContext.Provider value={member}>
      <div className="flex min-h-full flex-col bg-[#f4efe7]">
        <header className="sticky top-0 z-30 border-b border-stone-200 bg-paper/95 backdrop-blur print:hidden">
          <div className={`mx-auto flex items-center gap-2 px-3 py-2 ${wide ? 'max-w-[1500px]' : 'max-w-6xl'}`}>
            <span className="font-display mr-3 hidden text-lg font-bold text-brand-700 sm:block">Zaiqa</span>
            <nav className="flex flex-1 gap-1 overflow-x-auto">
              {NAV.filter((n) => !n.roles || n.roles.includes(member.role)).map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end
                  className={({ isActive }) =>
                    `whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold ${isActive ? 'bg-ink text-white' : 'text-stone-600 hover:bg-stone-100 hover:text-ink'}`
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <span className="hidden text-xs text-stone-500 sm:block">
              {member.display_name} · {member.role}
            </span>
            <button onClick={signOut} className="rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-100">
              Sign out
            </button>
          </div>
        </header>
        <main className={`mx-auto w-full flex-1 p-3 sm:p-4 ${wide ? 'max-w-[1500px]' : 'max-w-6xl'}`}>
          {allowed ? children : <Notice tone="amber">This screen is for the owner or a manager.</Notice>}
        </main>
      </div>
    </StaffContext.Provider>
  )
}
