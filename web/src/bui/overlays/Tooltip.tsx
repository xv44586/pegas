import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@bui/lib/utils'

export function TooltipProvider({
  children,
  delayDuration = 300,
}: {
  children: ReactNode
  delayDuration?: number
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'bui z-50 rounded-control px-2.5 py-1.5 text-[12px] font-medium',
          'data-[state=delayed-open]:animate-[fade-in_120ms_ease-out]',
          className,
        )}
        style={{
          background: 'var(--tooltip-bg)',
          color: 'var(--tooltip-fg)',
          boxShadow: 'var(--shadow-overlay)',
        }}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}
