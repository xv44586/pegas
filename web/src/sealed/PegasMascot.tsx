export type PegasMascotPose = 'idle' | 'waiting' | 'celebrate' | 'blocked'

const poseAssets: Record<
  PegasMascotPose,
  { file: string; width: number; height: number }
> = {
  idle: { file: 'pegas-mascot.webp', width: 640, height: 449 },
  waiting: { file: 'pegas-mascot-waiting.webp', width: 480, height: 445 },
  celebrate: { file: 'pegas-mascot-celebrate.webp', width: 480, height: 443 },
  blocked: { file: 'pegas-mascot-blocked.webp', width: 480, height: 437 },
}

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
  const asset = poseAssets[pose]

  return (
    <img
      {...accessibility}
      alt=""
      className={classes}
      data-pose={pose}
      decoding="async"
      draggable={false}
      height={Math.round((size * asset.height) / asset.width)}
      src={`/brand/${asset.file}`}
      width={size}
    />
  )
}
