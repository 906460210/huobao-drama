/** Decisions that keep remote generation submissions at most once during recovery. */
export type RecoverableTask = {
  status: string | null
  taskId: string | null
  resultUrl: string | null
  params: string | null
}

export function planTaskRecovery(task: RecoverableTask): 'download' | 'poll' | 'fail' | 'skip' {
  if (task.status === 'completed') return 'skip'
  if (task.resultUrl) return 'download'
  if (task.taskId) return 'poll'
  return 'fail'
}

export function pollFetchOptions(
  request: { method: string; headers: Record<string, string>; body?: unknown },
  timeoutMs: number,
  rejectRedirects = false,
): RequestInit {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal: AbortSignal.timeout(timeoutMs),
    ...(rejectRedirects ? { redirect: 'error' as const } : {}),
  }
  if (request.body !== undefined) {
    init.body = request.body instanceof FormData ? request.body : JSON.stringify(request.body)
  }
  return init
}
