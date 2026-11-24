import {
  Check,
  ChevronDown,
  Home,
  LogOut,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react'

interface ShimProps {
  size?: number
  className?: string
}

function makeShim(Icon: LucideIcon, strokeWidth = 2) {
  return function CentralIconShim({ size = 16, className }: ShimProps) {
    return (
      <Icon
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        aria-hidden
      />
    )
  }
}

export const IconHome = makeShim(Home)
export const IconMagnifyingGlass = makeShim(Search)
export const IconSettingsGear1 = makeShim(Settings)
export const IconPlusMedium = makeShim(Plus)
export const IconEditBig = makeShim(Pencil)
export const IconCrossSmall = makeShim(X)
export const IconCheckmark1Small = makeShim(Check)
export const IconChevronDownSmall = makeShim(ChevronDown)
export const IconSidebarLeftArrow = makeShim(PanelLeftClose)
export const IconArrowBoxLeft = makeShim(LogOut)
export const IconUserAdd = makeShim(UserPlus)

export function IconPopsicle2({ size = 18, className }: ShimProps) {
  return (
    <img
      src="/brand/agent-bot.webp"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden
      draggable={false}
      style={{ borderRadius: size * 0.28 }}
    />
  )
}
