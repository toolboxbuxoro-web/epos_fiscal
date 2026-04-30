import { getPoller, type PollerStatus } from '@/lib/moysklad/poller'

type Listener = (s: PollerStatus) => void

const listeners = new Set<Listener>()
let lastStatus: PollerStatus = {
  running: false,
  lastTickAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastFetchedCount: 0,
  intervalSec: 30,
}
let started = false

/** Запустить поллер один раз на всё приложение. */
export async function ensurePollerStarted(): Promise<void> {
  if (started) return
  started = true
  const p = getPoller({
    onTick: (s) => {
      lastStatus = s
      for (const l of listeners) l(s)
    },
  })
  await p.start()
}

export function subscribePollerStatus(fn: Listener): () => void {
  listeners.add(fn)
  fn(lastStatus)
  return () => {
    listeners.delete(fn)
  }
}
