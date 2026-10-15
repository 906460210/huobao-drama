function invalidWorkflow() {
  throw new Error('请选择“导出工作流 API”得到的 API 格式 JSON')
}

export function inspectRunninghubWorkflow(source) {
  let workflow
  try {
    workflow = typeof source === 'string' ? JSON.parse(source) : source
  } catch {
    invalidWorkflow()
  }

  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) invalidWorkflow()

  const nodes = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!/^\d+$/.test(nodeId)) continue
    if (!node || typeof node !== 'object' || Array.isArray(node)
      || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) invalidWorkflow()
    nodes.push({
      nodeId,
      classType: typeof node.class_type === 'string' ? node.class_type : '',
      inputNames: Object.keys(node.inputs),
    })
  }
  if (!nodes.length) invalidWorkflow()
  return nodes
}