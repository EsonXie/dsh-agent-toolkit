/** shared 数据加载状态机：loading/error/ok 三态 + stale 标志 + reload 计数器。 */
import { useEffect, useState } from 'react'

export type LoadState<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: T }

export function useLoadState<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ kind: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let stale = false
    setState({ kind: 'loading' })
    load()
      .then((data) => { if (!stale) setState({ kind: 'ok', data }) })
      .catch((error) => {
        if (!stale) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { stale = true }
    // deps 由调用方明确提供（重新加载触发条件），tick 由 reload 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { state, reload: () => { setTick((n) => n + 1) } }
}
