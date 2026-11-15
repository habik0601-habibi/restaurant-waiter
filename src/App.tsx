import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Spinner } from './components/ui'
import { StaffShell } from './components/StaffShell'
import Home from './pages/Home'

// Each surface is its own chunk, so a guest's phone never downloads staff code.
const GuestTable = lazy(() => import('./pages/guest/GuestTable'))
const GuestJoin = lazy(() => import('./pages/guest/GuestJoin'))
const Floor = lazy(() => import('./pages/staff/Floor'))
const Kitchen = lazy(() => import('./pages/staff/Kitchen'))
const Waitlist = lazy(() => import('./pages/staff/Waitlist'))
const QrCodes = lazy(() => import('./pages/staff/QrCodes'))
const Dashboard = lazy(() => import('./pages/owner/Dashboard'))
const MenuEditor = lazy(() => import('./pages/owner/MenuEditor'))

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Spinner label="Loading" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* guest: no login */}
          <Route path="/t/:token" element={<GuestTable />} />
          <Route path="/join" element={<GuestJoin />} />
          {/* staff: login required */}
          <Route path="/staff" element={<StaffShell wide><Floor /></StaffShell>} />
          <Route path="/staff/kitchen" element={<StaffShell wide><Kitchen /></StaffShell>} />
          <Route path="/staff/waitlist" element={<StaffShell><Waitlist /></StaffShell>} />
          <Route path="/staff/qr" element={<StaffShell><QrCodes /></StaffShell>} />
          {/* owner: owner or manager */}
          <Route path="/owner" element={<StaffShell managerOnly><Dashboard /></StaffShell>} />
          <Route path="/owner/menu" element={<StaffShell managerOnly><MenuEditor /></StaffShell>} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
