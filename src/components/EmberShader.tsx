import { Component, type ReactNode } from 'react'
import { FilmGrain, MeshGradient, Shader } from 'shaders/react'

// charcoal -> maroon -> chili -> saffron: the brand palette, dark-weighted so white text stays readable
const EMBER = [
  { color: '#17100c', position: 0 },
  { color: '#3d140b', position: 0.35 },
  { color: '#a93620', position: 0.7 },
  { color: '#d98e12', position: 1 },
]

/** If the GPU or driver refuses, fall back silently to the CSS gradient underneath. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * Two layers: a slowly drifting mesh gradient in the brand colours, and film
 * grain on top for texture.
 */
export default function EmberShader() {
  return (
    <Quiet>
      {/* telemetry off: guests' phones should not report to a third party */}
      <Shader className="absolute inset-0 h-full w-full" disableTelemetry>
        <MeshGradient stops={EMBER} colorSpace="oklab" speed={0.3} wrapping={0} />
        <FilmGrain strength={0.2} />
      </Shader>
    </Quiet>
  )
}
