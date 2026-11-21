interface PegasMascotProps {
  size?: number
  label?: string
  className?: string
}

export function PegasMascot({
  size = 132,
  label,
  className,
}: PegasMascotProps) {
  const classes = ['pegas-mascot', className ?? ''].filter(Boolean).join(' ')
  const accessibility = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)

  return (
    <img
      {...accessibility}
      alt=""
      className={classes}
      decoding="async"
      draggable={false}
      height={Math.round((size * 449) / 640)}
      src="/brand/pegas-mascot.webp"
      width={size}
    />
  )
}
