/** Token 用量模态框：翻页头 + 24 小时柱状图 + 总量 + 三维细分（Task 10 填充）。 */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 今天（以端点返回的 today 为准）。 */
  initialDate: string | null
}

export function UsageModal({ open, onClose }: UsageModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭">
      <p>加载中…</p>
    </Modal>
  )
}
