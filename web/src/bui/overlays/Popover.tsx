import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'

import { cn } from '@bui/lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bui z-50 min-w-40 rounded-card bg-surface p-1 shadow-overlay outline-none',
          'data-[state=open]:animate-[pop-in_150ms_var(--ease-link)]',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
