/*
 * Generic interface icon geometry reproduced or adapted from DS Bot's
 * Apache-2.0 licensed client. Pegas product and Worker identities live in
 * PegasAgentIcon.tsx and the generated Pegas icon sprite.
 * See THIRD_PARTY_NOTICES.md.
 */

import type { ReactNode } from 'react'

interface IconProps {
  size?: number
}

function LineIcon({
  children,
  size = 16,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function DsFolderIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M3 6A1.5 1.5 0 0 1 4.5 4.5h3.2l1.8 2h6A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" />
    </LineIcon>
  )
}

export function DsSearchIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M13 13l4 4" />
    </LineIcon>
  )
}

export function DsPlusIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10 3.5v13M3.5 10h13" />
    </LineIcon>
  )
}

export function DsSidebarIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2.5" />
      <path d="M8 4v12" />
    </LineIcon>
  )
}

export function DsPanelIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2.5" />
      <path d="M12 4v12" />
    </LineIcon>
  )
}

export function DsGearIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10 7.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z" />
      <path d="M7.85 4.4l.29-1.87a7.7 7.7 0 0 1 3.72 0l.29 1.87a6 6 0 0 1 1.63.94l1.76-.69a7.7 7.7 0 0 1 1.86 3.23l-1.47 1.18a6 6 0 0 1 0 1.88l1.47 1.18a7.7 7.7 0 0 1-1.86 3.23l-1.76-.69a6 6 0 0 1-1.63.94l-.29 1.87a7.7 7.7 0 0 1-3.72 0l-.29-1.87a6 6 0 0 1-1.63-.94l-1.76.69a7.7 7.7 0 0 1-1.86-3.23l1.47-1.18a6 6 0 0 1 0-1.88L2.6 7.88a7.7 7.7 0 0 1 1.86-3.23l1.76.69a6 6 0 0 1 1.63-.94z" />
    </LineIcon>
  )
}

export function DsPlugIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M7 3v4M13 3v4" />
      <path d="M5 7h10v2.5a5 5 0 0 1-10 0z" />
      <path d="M10 14.5V17" />
    </LineIcon>
  )
}

export function DsMicIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect
        x="7"
        y="2.5"
        width="6"
        height="10"
        rx="3"
        fill="currentColor"
        stroke="none"
      />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
    </svg>
  )
}

export function DsWaveIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="7.5" width="2" height="5" rx="1" />
      <rect x="5.5" y="4.5" width="2" height="11" rx="1" />
      <rect x="9" y="2.5" width="2" height="15" rx="1" />
      <rect x="12.5" y="5.5" width="2" height="9" rx="1" />
      <rect x="16" y="8" width="2" height="4" rx="1" />
    </svg>
  )
}

export function DsArrowUpIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10 16V4M5 9l5-5 5 5" />
    </LineIcon>
  )
}

export function DsCloseIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 5l10 10M15 5L5 15" />
    </LineIcon>
  )
}

export function DsSmileIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z" />
      <path d="M7.3 11.6a3.4 3.4 0 0 0 5.4 0M7.75 8.25h.01M12.25 8.25h.01" />
    </LineIcon>
  )
}

export function DsReplyIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M8 5L4 9l4 4M4 9h7.5a4.5 4.5 0 0 1 4.5 4.5V15" />
    </LineIcon>
  )
}

export function DsDotsIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 10h.01M10 10h.01M15 10h.01" />
    </LineIcon>
  )
}

export function DsMainStarIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.4l2.29 5.04 5.51.63-4.09 3.74 1.11 5.42L10 14.5l-4.82 2.73 1.11-5.42L2.2 8.07l5.51-.63z" />
    </svg>
  )
}
