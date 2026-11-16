import { Link } from 'react-router-dom'
import { EmberBackdrop } from '../components/EmberBackdrop'
import { Icon, type IconName } from '../components/Icon'

const SURFACES: { title: string; icon: IconName; body: string; links: { to: string; label: string }[] }[] = [
  {
    title: 'Guest',
    icon: 'scan',
    body: 'Guests reach their table by scanning its QR code. Open or print the codes from the staff QR page.',
    links: [{ to: '/join', label: 'Join the queue or reserve' }],
  },
  {
    title: 'Staff',
    icon: 'utensils',
    body: 'Floor map, kitchen display, waitlist and QR codes. Login required.',
    links: [
      { to: '/staff', label: 'Floor map' },
      { to: '/staff/kitchen', label: 'Kitchen display' },
      { to: '/staff/waitlist', label: 'Waitlist' },
      { to: '/staff/qr', label: 'Table QR codes' },
    ],
  },
  {
    title: 'Owner',
    icon: 'receipt',
    body: 'Menu editing and profit analysis. Owner or manager login required.',
    links: [
      { to: '/owner', label: 'Profit dashboard' },
      { to: '/owner/menu', label: 'Menu editor' },
    ],
  },
]

const POINTS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'clock', title: 'Dishes land together', body: 'A kitchen scheduler times every dish so a table’s food finishes at once.' },
  { icon: 'scan', title: 'A photo of the QR is useless', body: 'Ordering needs a session that staff open. The database enforces it.' },
  { icon: 'users', title: 'One live floor', body: 'Tables, calls, waitlist and bills are driven by one shared state machine.' },
]

/** Landing page: what the product is, and a way into each of the three surfaces. */
export default function Home() {
  return (
    <div className="min-h-full">
      <header className="relative isolate overflow-hidden bg-brand-900 text-white">
        <EmberBackdrop />
        <div className="relative mx-auto max-w-5xl px-5 pb-16 pt-14 sm:pb-24 sm:pt-20">
          <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-saffron-400">Zaiqa Karahi House</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-[1.08] sm:text-6xl">The website that does the work of a waiter.</h1>
          <div className="ember-rule mt-5" />
          <p className="mt-5 max-w-xl text-base text-white/85 sm:text-lg">
            Guests order, call staff and pay from their phone. Staff run the room from one live floor map. The kitchen cooks to a
            schedule.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/staff" className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-saffron-500 px-5 font-bold text-coal hover:bg-saffron-400">
              Open the floor <Icon name="arrow" />
            </Link>
            <Link to="/staff/qr" className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-5 font-semibold text-white backdrop-blur hover:bg-white/20">
              <Icon name="scan" /> Table QR codes
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5">
        <section className="-mt-8 grid gap-4 sm:grid-cols-3">
          {POINTS.map((p) => (
            <div key={p.title} className="relative rounded-2xl border border-stone-200/80 bg-paper p-5 shadow-card">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Icon name={p.icon} />
              </span>
              <h2 className="mt-3 text-lg font-bold">{p.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-stone-600">{p.body}</p>
            </div>
          ))}
        </section>

        <section className="py-12">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-stone-500">Three surfaces, one database</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {SURFACES.map((s) => (
              <div key={s.title} className="rounded-2xl border border-stone-200/80 bg-paper p-5 shadow-card">
                <div className="flex items-center gap-2 text-brand-700">
                  <Icon name={s.icon} />
                  <h2 className="text-xl font-bold text-ink">{s.title}</h2>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-stone-600">{s.body}</p>
                <ul className="mt-4 space-y-1 border-t border-stone-200 pt-3">
                  {s.links.map((l) => (
                    <li key={l.to}>
                      <Link to={l.to} className="group flex min-h-10 items-center justify-between rounded-lg px-2 text-sm font-semibold text-ink hover:bg-brand-50 hover:text-brand-700">
                        {l.label}
                        <Icon name="arrow" className="h-4 w-4 text-stone-400 group-hover:text-brand-600" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
