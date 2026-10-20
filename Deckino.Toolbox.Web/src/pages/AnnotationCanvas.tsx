import { Loader, Stack, Text } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import styles from './AnnotationCanvas.module.css'

export type Point = { x: number; y: number }
export type CanvasControls = { zoomIn: () => void; zoomOut: () => void; reset: () => void }

const MinZoom = 1
const MaxZoom = 8
const WheelStep = 1.15
const ButtonStep = 1.2
const HitRadius = 18
// Edges are drawn past each corner, so the lines can be laid along the card's straight edges.
const GuideExtension = 0.12

type View = { zoom: number; x: number; y: number }
// A marker held by the pointer. `from`: where the pointer went down, in canvas pixels (a marker only clicked, not
// moved, is just selected). `offset`: the marker from the pointer, kept wherever on the marker it was grabbed.
type Drag = { index: number; point: Point; from: { x: number; y: number }; offset: { x: number; y: number }; moved: boolean }
// A marker dropped where the Toolbox has yet to put it.
type Placed = { index: number; point: Point }
const DragThreshold = 3

/**
 * The photo with its corner points. Click places the next corner, a marker drags, the wheel zooms at the cursor and
 * the right or middle button pans. Points are normalized to the photo (0..1); markers keep their size at any zoom.
 */
export default function AnnotationCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  points,
  loading,
  onAdd,
  onPlace,
  onZoomChange,
  ref,
}: {
  imageUrl: string | null
  imageWidth: number
  imageHeight: number
  points: Point[]
  loading: boolean
  onAdd: (point: Point) => void
  /** Resolves once the Toolbox has the point (or refused it). */
  onPlace: (index: number, point: Point) => Promise<void>
  onZoomChange?: (zoom: number) => void
  ref?: Ref<CanvasControls>
}) {
  const { ref: sizeRef, width, height } = useElementSize()
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [selected, setSelected] = useState(-1)
  // Kept in a ref too: a pointerup can come before the render of the last pointermove.
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }
  const [placed, setPlaced] = useState<Placed[]>([])
  const pan = useRef<{ x: number; y: number } | null>(null)
  const [panning, setPanning] = useState(false)

  // The photo fitted into the canvas at zoom 1.
  const scale = imageWidth > 0 && imageHeight > 0 ? Math.min(width / imageWidth, height / imageHeight) : 0
  const fit = { w: imageWidth * scale, h: imageHeight * scale, x: (width - imageWidth * scale) / 2, y: (height - imageHeight * scale) / 2 }
  const center = { x: width / 2, y: height / 2 }

  const clamp = (next: View): View => {
    const zoom = Math.min(MaxZoom, Math.max(MinZoom, next.zoom))
    const maxX = Math.max(0, (fit.w * zoom - width) / 2)
    const maxY = Math.max(0, (fit.h * zoom - height) / 2)
    return { zoom, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) }
  }

  // Keeps the photo point under `focus` (canvas pixels) where it is.
  const zoomAt = (factor: number, focus = center) =>
    setView((current) => {
      const zoom = Math.min(MaxZoom, Math.max(MinZoom, current.zoom * factor))
      const baseX = (focus.x - current.x - center.x) / current.zoom
      const baseY = (focus.y - current.y - center.y) / current.zoom
      return clamp({ zoom, x: focus.x - center.x - baseX * zoom, y: focus.y - center.y - baseY * zoom })
    })

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomAt(ButtonStep),
    zoomOut: () => zoomAt(1 / ButtonStep),
    reset: () => setView({ zoom: 1, x: 0, y: 0 }),
  }))

  // A new photo starts fitted, with nothing selected.
  useEffect(() => {
    setView({ zoom: 1, x: 0, y: 0 })
    setSelected(-1)
    setDrag(null)
    setPlaced([])
  }, [imageUrl])

  useEffect(() => onZoomChange?.(view.zoom), [view.zoom, onZoomChange])

  const toCanvas = (point: Point) => ({
    x: (fit.x + point.x * fit.w - center.x) * view.zoom + center.x + view.x,
    y: (fit.y + point.y * fit.h - center.y) * view.zoom + center.y + view.y,
  })
  const toPhoto = (x: number, y: number): Point => ({
    x: ((x - view.x - center.x) / view.zoom + center.x - fit.x) / fit.w,
    y: ((y - view.y - center.y) / view.zoom + center.y - fit.y) / fit.h,
  })
  const clampPoint = (point: Point): Point => ({ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) })

  const current = points.map((point, index) => placed.find((placement) => placement.index === index)?.point ?? point)
  const shown = current.map((point, index) => (drag?.index === index ? drag.point : point)).map(toCanvas)

  const local = (event: React.PointerEvent | React.WheelEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!imageUrl || loading || fit.w === 0) return
    const at = local(event)
    if (event.button === 1 || event.button === 2) {
      if (view.zoom <= 1) return
      pan.current = at
      setPanning(true)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    const hit = shown.findIndex((point) => Math.hypot(point.x - at.x, point.y - at.y) <= HitRadius)
    if (hit >= 0) {
      setSelected(hit)
      const offset = { x: shown[hit].x - at.x, y: shown[hit].y - at.y }
      setDrag({ index: hit, point: current[hit], from: at, offset, moved: false })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const point = toPhoto(at.x, at.y)
    if (points.length >= 4 || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return
    setSelected(points.length)
    onAdd(point)
  }

  // Ends a drag or a pan. A drag the system takes away (a dialog taking the pointer, say) puts the marker back.
  const onPointerCancel = () => {
    setDrag(null)
    pan.current = null
    setPanning(false)
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    // A release the window never saw ends the drag as a cancel would.
    if (event.buttons === 0 && (dragRef.current || pan.current)) return onPointerCancel()
    const at = local(event)
    const drag = dragRef.current
    if (drag) {
      if (drag.moved || Math.hypot(at.x - drag.from.x, at.y - drag.from.y) > DragThreshold)
        setDrag({ ...drag, point: clampPoint(toPhoto(at.x + drag.offset.x, at.y + drag.offset.y)), moved: true })
    } else if (pan.current) {
      const last = pan.current
      pan.current = at
      setView((current) => clamp({ ...current, x: current.x + at.x - last.x, y: current.y + at.y - last.y }))
    }
  }

  const onPointerUp = () => {
    const drag = dragRef.current
    if (drag?.moved) {
      // The marker stays where it was dropped until the Toolbox's points have caught up.
      const placement = { index: drag.index, point: drag.point }
      setPlaced((list) => [...list.filter((other) => other.index !== drag.index), placement])
      void onPlace(drag.index, drag.point).finally(() => setPlaced((list) => list.filter((other) => other !== placement)))
    }
    onPointerCancel()
  }

  const edges = shown.length === 4 ? [0, 1, 2, 3].map((index) => [shown[index], shown[(index + 1) % 4]]) : []
  const outline = shown.map((point) => `${point.x},${point.y}`).join(' ')

  return (
    <div ref={sizeRef} className={styles.canvas}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className={styles.photo}
          style={{
            left: fit.x,
            top: fit.y,
            width: fit.w,
            height: fit.h,
            transformOrigin: `${center.x - fit.x}px ${center.y - fit.y}px`,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
        />
      ) : (
        !loading && (
          <Stack className={styles.empty} align="center" justify="center" gap={4}>
            <Text fw={600}>No photo to annotate</Text>
            <Text size="sm" c="dimmed">
              Import a folder or refresh the queue.
            </Text>
          </Stack>
        )
      )}

      <svg
        className={styles.overlay}
        data-dragging={drag !== null || panning || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onWheel={(event) => imageUrl && zoomAt(event.deltaY < 0 ? WheelStep : 1 / WheelStep, local(event))}
        onContextMenu={(event) => event.preventDefault()}
      >
        {edges.map(([start, end], index) => {
          const dx = (end.x - start.x) * GuideExtension
          const dy = (end.y - start.y) * GuideExtension
          return (
            <g key={index} className={styles.guide}>
              <line x1={start.x - dx} y1={start.y - dy} x2={start.x} y2={start.y} />
              <line x1={end.x} y1={end.y} x2={end.x + dx} y2={end.y + dy} />
            </g>
          )
        })}
        {shown.length > 1 &&
          (shown.length === 4 ? (
            <>
              <polygon points={outline} className={styles.edgeShadow} />
              <polygon points={outline} className={styles.edge} />
            </>
          ) : (
            <>
              <polyline points={outline} className={styles.edgeShadow} />
              <polyline points={outline} className={styles.edge} />
            </>
          ))}
        {shown.map((point, index) => (
          <g key={index} data-selected={index === selected || undefined} className={styles.marker}>
            <circle cx={point.x} cy={point.y} r={index === selected ? 11 : 10} className={styles.markerShadow} />
            <circle cx={point.x} cy={point.y} r={index === selected ? 8 : 7} className={styles.markerFill} />
            <text x={point.x + 12} y={point.y - 10} className={styles.markerLabel}>
              {index + 1}
            </text>
          </g>
        ))}
      </svg>

      {loading && (
        <Stack className={styles.loading} align="center" justify="center" gap="xs">
          <Loader />
          <Text size="sm" c="dimmed">
            Loading workspace…
          </Text>
        </Stack>
      )}
    </div>
  )
}
