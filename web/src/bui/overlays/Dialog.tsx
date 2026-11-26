import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@bui/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  children,
  className,
  closeLabel = '关闭',
  showClose = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  closeLabel?: string
  showClose?: boolean
}) {
  const opener = useRef<HTMLElement | null>(null)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="bui fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          'bui fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2',
          'rounded-window bg-surface p-5 shadow-overlay outline-none',
          'data-[state=open]:animate-[pop-in_180ms_var(--ease-link)]',
          className,
        )}
        {...props}
        onOpenAutoFocus={event => {
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event)
          // Controlled dialogs may have no Radix DialogTrigger to restore.
          if (
            !event.defaultPrevented &&
            opener.current?.isConnected &&
            opener.current !== document.body
          ) {
            event.preventDefault()
            opener.current.focus()
          }
        }}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="primitive-icon-button pointer-coarse:size-11 absolute top-3 right-3 text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-[15px] font-medium text-ink', className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('mt-1.5 text-[13px] leading-relaxed text-ink-2', className)}
      {...props}
    />
  )
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2">{children}</div>
  )
}
