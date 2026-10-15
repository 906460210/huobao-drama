/** Decide whether a failed video action can reuse an existing paid task. */
export function videoRetryAction(task) {
  if (task?.provider !== 'runninghub' || task.status !== 'failed') return 'generate'
  return task.task_id || task.taskId || task.result_url || task.resultUrl
    ? 'resume' : 'review'
}
