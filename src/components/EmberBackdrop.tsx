import { lazy, Suspense, useEffect, useState } from 'react'

// The WebGPU shader lives in its own chunk. A phone without WebGPU never downloads it.
const EmberShader = lazy(() => import('./EmberShader'))

/**
 * Animated "ember" background for hero areas: a slow mesh gradient of
 * charcoal, chili and saffron with a little grain, like heat over coals.
 *
 * It is decoration only. A static CSS gradient with the same colours is
 * always painted underneath, and the shader is mounted only when the browser
 * has WebGPU and the visitor has not asked for reduced motion. Text on top
 * therefore reads the same with or without it.
 */
export function EmberBackdrop({ className = '' }: { className?: string }) {
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // The shader chunk is large (about 300 kB compressed), so it is skipped on
    // data-saver and slow connections and only fetched after the page has painted.
    const net = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    const slow = !!net && (net.saveData === true || /(^|-)2g$|3g/.test(net.effectiveType ?? ''))
    if (reduce || slow || !('gpu' in navigator)) return
    const start = () => setAnimate(true)
    const handle = window.setTimeout(start, 400)
    return () => window.clearTimeout(handle)
  }, [])

  return (
    <div className={`ember-fallback pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true">
      {animate && (
        <Suspense fallback={null}>
          <EmberShader />
        </Suspense>
      )}
      {/* keeps white text readable whatever the gradient is doing */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/10 to-black/45" />
    </div>
  )
}
