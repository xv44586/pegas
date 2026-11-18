/*
 * Icon and whale-character geometry reproduced or adapted from DS Bot's
 * Apache-2.0 licensed client. Modified for Pegas React/TypeScript use.
 * See THIRD_PARTY_NOTICES.md.
 */

import { useId, type ReactNode } from 'react'

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

/**
 * DS Bot's default whale character. The path, paint, shading, and eye geometry
 * are kept identical to the Apache-2.0 source so Pegas can use the same
 * temporary product character while its own asset set is still pending.
 */
export function DsWhaleMark({ size = 34 }: IconProps) {
  const maskId = useId().replaceAll(':', '')

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="-100"
          y="-100"
          width="300"
          height="300"
        >
          <rect x="-100" y="-100" width="300" height="300" fill="white" />
          <g fill="black">
            <g transform="translate(72.5 48.4) rotate(-15.8)">
              <rect x="-4.65" y="-11.5" width="9.3" height="23" rx="4.65" />
            </g>
            <g transform="translate(85.6 43.4) rotate(-21.2)">
              <rect x="-3.5" y="-11.45" width="7" height="22.9" rx="3.5" />
            </g>
          </g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`} fillRule="evenodd">
        <path
          d="M65.3 20.9l5.1.1 4.8.9 4.8 1.7 4.3 2.3 3.8 3.1 3 3.4 2.3 3.8 1.6 4.3.9 4.3 0 4.8-.8 4.8-1.4 4.3-2.3 4.3-3.2 4.3-3.4 3.3-4.3 3.1-7.2 3.5-7.6 1.7-7.2.1-9.6-1.6-3.3-1-2.9-1.7-8.8-8.9-6-4.7-3.3-.5-7.7 1.1-4.8-.1-4.7-1.2-1.9-1.2-1-1-.5-1.5.4-1.4 1.1-1.3 1.9-1.3 4.7-1.5 7.7-.6 1.1-.5.7-1 0-1.4-2.8-7.2-1.2-5.3-.1-4.3.4-1.4.9-1.2 1.9-.2 2 1 2.2 2.3 2.2 3.4 3.2 7.6 1.9 9.7.5-.1 1.1-7.2 1.8-4.8 3.2-5.2 3.9-4.3 4.9-3.9 5.6-2.9 5.8-1.9z"
          fill="#4D6BFE"
        />
        <path
          d="M93.3 55.8l1-.3.1 1.2-2.4 5.3-3.4 4.8-3.8 3.8-4.8 3.4-5.7 2.8-4.8 1.5-4.8.4 20.1-17.4 5.2-3.7z"
          fill="white"
        />
        <path
          d="M88.6 29.5l2.4 2.9 1.9 2.8 2.4 6.3.5 3.3.1 5.3-1.5 6.6-1.9 4.3-2 3.3-4.8 5.4-5.7 4.3-7.2 3.3-6.2 1.5-6.7.1-3.3-.2-9.6-1.8-3.3-1.5-2.4-1.9-8.6-8.9-5.3-3.9-3.3-.1-2.9.2-3.3.8-5.8 0-4.3-1-2.9-1.9.6-.6 3.8-1.3 10.5-2.5 4.3.9 1.4-.1 2.2-1.7.5-1.4-.3-1.5-1.2-1.4-2.2-1.4-1.2-1.9-.6-12 .4-3.3.5-.5 2.9 3.8 2.4 4.8 1.9 5.7.7 5.8.7 2.8 2.1 2.4 2.7 5.5 3.8 4.3 2.9 2.2 3.3 1 3.4-.4 6.2-3 7.1-4.5 7.3-5.6 6.6-5.9 5.9-6.5 3.7-5.3 1.7-4.2.1-2.9z"
          fill="black"
          fillOpacity=".07"
        />
      </g>
    </svg>
  )
}
