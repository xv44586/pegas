import { pegasBotIconUrl } from '../agent-icon-id'

export function PegasMark({ size = 34 }: { size?: number }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="pegas-mark"
      decoding="async"
      draggable={false}
      height={size}
      src={pegasBotIconUrl}
      width={size}
    />
  )
}
