import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useStaff } from '../../components/StaffShell'
import { Button, Card, Notice, Spinner } from '../../components/ui'
import { friendly } from '../../lib/format'
import { staffDb } from '../../lib/supabase'

interface TableToken {
  table_id: string
  label: string
  capacity: number
  token: string
}

function QrImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)
    QRCode.toDataURL(url, { margin: 1, width: 320 })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  if (failed) return <div className="flex h-48 w-48 items-center justify-center text-center text-sm text-red-700">Could not draw this code</div>
  if (!src) return <div className="h-48 w-48 animate-pulse rounded-lg bg-stone-100" />
  return <img src={src} alt={alt} width={192} height={192} className="h-48 w-48" />
}

const LINK = 'inline-flex min-h-9 items-center rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50'

export default function QrCodes() {
  const member = useStaff()
  const canRotate = member.role === 'owner' || member.role === 'manager'
  const [rows, setRows] = useState<TableToken[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rotating, setRotating] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await staffDb.rpc('staff_table_tokens', { p_branch: member.branch_id })
    if (error) {
      setError(friendly(error))
      return
    }
    setError(null)
    setRows((data as TableToken[] | null) ?? [])
  }, [member.branch_id])

  useEffect(() => {
    void load()
  }, [load])

  async function rotate(t: TableToken) {
    const ok = window.confirm(
      `Make a new code for table ${t.label}?\n\nEvery printed copy of the current code will stop working straight away. You will need to print and replace it.`,
    )
    if (!ok) return
    setRotating(t.table_id)
    const { error } = await staffDb.rpc('staff_rotate_qr', { p_table: t.table_id })
    if (error) setError(friendly(error))
    else await load()
    setRotating(null)
  }

  const origin = window.location.origin
  const joinUrl = `${origin}/join`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div>
          <h1 className="text-xl font-bold">Table QR codes</h1>
          <p className="text-sm text-stone-600">Print one per table. Guests scan it to order from their phone.</p>
        </div>
        <Button onClick={() => window.print()} disabled={!rows}>
          Print
        </Button>
      </div>

      {error && (
        <div className="print:hidden">
          <Notice>{error}</Notice>
        </div>
      )}

      {!rows && !error && <Spinner label="Loading table codes" />}

      {rows && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-2">
          {rows.map((t) => {
            const path = `/t/${t.token}`
            const url = `${origin}${path}`
            return (
              <Card key={t.table_id} className="flex break-inside-avoid flex-col items-center gap-2 p-4 text-center">
                <p className="text-3xl font-extrabold">Table {t.label}</p>
                <p className="text-sm text-stone-600">Seats {t.capacity}</p>
                <QrImage url={url} alt={`QR code for table ${t.label}`} />
                <p className="text-lg font-bold text-brand-700">Scan to order</p>
                <p className="w-full break-all text-[10px] leading-tight text-stone-500">{url}</p>
                <div className="flex flex-wrap justify-center gap-2 print:hidden">
                  <a href={path} target="_blank" rel="noreferrer" className={LINK}>
                    Open as guest
                  </a>
                  <a href={`${path}?guest=2`} target="_blank" rel="noreferrer" className={LINK}>
                    Open as 2nd guest
                  </a>
                  {canRotate && (
                    <Button variant="secondary" size="sm" disabled={rotating !== null} onClick={() => void rotate(t)}>
                      {rotating === t.table_id ? 'Making…' : 'New code'}
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}

          <Card className="flex break-inside-avoid flex-col items-center gap-2 border-saffron-400 p-4 text-center">
            <p className="text-3xl font-extrabold">At the door</p>
            <p className="text-sm text-stone-600">Zaiqa Karahi House</p>
            <QrImage url={joinUrl} alt="QR code to join the queue or reserve" />
            <p className="text-lg font-bold text-brand-700">No table yet? Scan to join the queue or reserve</p>
            <p className="w-full break-all text-[10px] leading-tight text-stone-500">{joinUrl}</p>
            <div className="flex flex-wrap justify-center gap-2 print:hidden">
              <a href="/join" target="_blank" rel="noreferrer" className={LINK}>
                Open as guest
              </a>
              <a href="/join?guest=2" target="_blank" rel="noreferrer" className={LINK}>
                Open as 2nd guest
              </a>
            </div>
          </Card>
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="print:hidden">
          <Notice tone="amber">This branch has no tables yet.</Notice>
        </div>
      )}
    </div>
  )
}
