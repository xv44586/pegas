const poseAssets = {
  idle: 'pegas-home.svg',
  waiting: 'pegas-home.svg',
  celebrate: 'pegas-home.svg',
  blocked: 'pegas-home.svg',
  working: 'pegas-flight.svg',
  speaking: 'pegas-speaking.svg',
} as const

export type PegasMascotPose = keyof typeof poseAssets

interface PegasMascotProps {
  size?: number
  label?: string
  className?: string
  pose?: PegasMascotPose
}

export function PegasMascot({
  size = 132,
  label,
  className,
  pose = 'idle',
}: PegasMascotProps) {
  const classes = ['pegas-mascot', className ?? ''].filter(Boolean).join(' ')
  const accessibility = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)

  const image = (
    <img
      {...accessibility}
      alt=""
      className={classes}
      data-pose={pose}
      decoding="async"
      draggable={false}
      height={size}
      src={`/brand/${poseAssets[pose]}`}
      width={size}
    />
  )

  if (pose === 'working' || pose === 'speaking') {
    return (
      <picture className="pegas-mascot-motion">
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet={`/brand/${poseAssets.idle}`}
        />
        {image}
      </picture>
    )
  }
  return image
}
