import type { CSSProperties } from 'react'

import { agentIconSprite } from './agent-icon-sprite'
import type { TaskStatus, WorkerIconId } from './types'

type PegasAgentIconId = 'bot' | WorkerIconId

const spriteElementId = 'pegas-agent-sprite'

export function PegasAgentSprite() {
  return (
    <div
      aria-hidden="true"
      className="pegas-agent-sprite"
      dangerouslySetInnerHTML={{ __html: agentIconSprite }}
      id={spriteElementId}
      style={{ display: 'none' }}
    />
  )
}

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
        <use href={`#pegas-agent-${iconId}`} />
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
