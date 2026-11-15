import { Link } from 'react-router-dom'
import { Card } from '../components/ui'

/** Landing page: explains the three surfaces and links into each. */
export default function Home() {
  const surfaces = [
    {
      title: 'Guest',
      body: 'Guests reach their table by scanning its QR code. Print or open the codes from the staff QR page.',
      links: [{ to: '/join', label: 'Join the waitlist or reserve' }],
    },
    {
      title: 'Staff',
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
      body: 'Menu editing and profit analysis. Owner or manager login required.',
      links: [
        { to: '/owner', label: 'Dashboard' },
        { to: '/owner/menu', label: 'Menu editor' },
      ],
    },
  ]
  return (
    <div className="mx-auto max-w-3xl p-5">
      <header className="mb-6 rounded-3xl bg-brand-900 p-6 text-white">
        <p className="text-sm uppercase tracking-widest text-saffron-400">Zaiqa Karahi House</p>
        <h1 className="mt-1 text-3xl font-bold">Table ordering</h1>
        <p className="mt-2 max-w-xl text-sm text-brand-100">
          Guests order, call staff and pay from their phone. Staff run the room from one live floor map. The kitchen
          cooks to a schedule that lands every table&apos;s dishes together.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        {surfaces.map((s) => (
          <Card key={s.title} className="p-4">
            <h2 className="font-bold">{s.title}</h2>
            <p className="mt-1 text-sm text-stone-600">{s.body}</p>
            <ul className="mt-3 space-y-1">
              {s.links.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="text-sm font-medium text-brand-600 underline-offset-2 hover:underline">
                    {l.label} →
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}
