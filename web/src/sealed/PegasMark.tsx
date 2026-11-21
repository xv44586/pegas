export function PegasMark({ size = 34 }: { size?: number }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="pegas-mark"
      decoding="async"
      draggable={false}
      height={size}
      src="/brand/agent-bot.webp"
      width={size}
    />
  )
}
