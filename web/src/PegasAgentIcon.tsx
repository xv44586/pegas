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
    <span
      {...accessibility}
      className={classes}
      style={{ '--pegas-avatar-size': `${String(size)}px` } as CSSProperties}
    >
      <svg
        aria-hidden="true"
        className="pegas-agent-glyph"
        focusable="false"
        viewBox="0 0 64 64"
        width={size}
        height={size}
      >
        <use href={`/icons/agents/pegas-agents.svg#pegas-agent-${iconId}`} />
      </svg>
      {status && (
        <span
          aria-hidden="true"
          className="pegas-agent-status"
          data-status={status}
        />
      )}
    </span>
  )
}
