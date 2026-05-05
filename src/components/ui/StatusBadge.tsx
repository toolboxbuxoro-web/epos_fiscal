import { Check, Clock, AlertCircle, AlertTriangle, Info, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from './Badge'

/**
 * Семантический бейдж со статусом — иконка автоматически по варианту,
 * не нужно каждый раз импортировать Lucide.
 *
 *   <StatusBadge status="success">Фискализирован</StatusBadge>
 *   <StatusBadge status="pending">Ожидает</StatusBadge>
 *   <StatusBadge status="error">Ошибка</StatusBadge>
 *
 * Если нужен кастомный icon — используй обычный <Badge icon={...}>.
 */
type Status = 'success' | 'pending' | 'warning' | 'error' | 'info' | 'loading' | 'neutral'

interface Props {
  status: Status
  children: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

const ICON_SIZE_PX = 12

const config: Record<
  Status,
  { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; icon: ReactNode | null }
> = {
  success: { variant: 'success', icon: <Check size={ICON_SIZE_PX} /> },
  pending: { variant: 'neutral', icon: <Clock size={ICON_SIZE_PX} /> },
  warning: { variant: 'warning', icon: <AlertTriangle size={ICON_SIZE_PX} /> },
  error: { variant: 'danger', icon: <AlertCircle size={ICON_SIZE_PX} /> },
  info: { variant: 'info', icon: <Info size={ICON_SIZE_PX} /> },
  loading: {
    variant: 'info',
    icon: <Loader2 size={ICON_SIZE_PX} className="animate-spin" />,
  },
  neutral: { variant: 'neutral', icon: null },
}

export function StatusBadge({ status, children, size = 'md', className }: Props) {
  const c = config[status]
  return (
    <Badge variant={c.variant} size={size} icon={c.icon} className={className}>
      {children}
    </Badge>
  )
}
