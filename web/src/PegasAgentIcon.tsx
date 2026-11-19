import type { CSSProperties } from 'react'

import type { TaskStatus, WorkerIconId } from './types'

type PegasAgentIconId = 'bot' | WorkerIconId

interface PegasAgentIconProps {
  iconId: PegasAgentIconId
  size?: number
  status?: TaskStatus
  label?: string
  className?: string
}

export function PegasAgentIcon({
  iconId,
  size = 34,
  status,
  label,
  className,
}: PegasAgentIconProps) {
  const classes = [
    'pegas-agent-avatar',
    status ? `status-${status}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  const accessibility = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)

  return (
    <svg
      {...accessibility}
      className={classes}
      focusable="false"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ '--pegas-avatar-size': `${String(size)}px` } as CSSProperties}
    >
      <use href={`/icons/agents/pegas-agents.svg#pegas-agent-${iconId}`} />
    </svg>
  )
}
