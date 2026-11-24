import * as ToastPrimitive from '@radix-ui/react-toast'
import { cva } from 'class-variance-authority'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@bui/lib/utils'

export const ToastProvider = ToastPrimitive.Provider

const toastVariants = cva(
  'bui flex items-start gap-3 rounded-card bg-surface p-3.5 shadow-overlay data-[state=open]:animate-[fade-up_200ms_var(--ease-link)] data-[swipe=end]:animate-[fade-in_120ms_ease-in_reverse]',
  {
    variants: {
      tone: {
        neutral: '',
        green: '[&_[data-toast-dot]]:bg-green',
        red: '[&_[data-toast-dot]]:bg-red',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Toast({
  className,
  tone = 'neutral',
  ...props
}: ComponentProps<typeof ToastPrimitive.Root> & {
  tone?: 'neutral' | 'green' | 'red'
}) {
  return (
    <ToastPrimitive.Root
      className={cn(toastVariants({ tone }), className)}
      {...props}
    />
  )
}

export function ToastTitle({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      className={cn('text-[13px] font-medium text-ink', className)}
      {...props}
    />
  )
}

export function ToastDescription({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      className={cn('mt-0.5 text-[12.5px] text-ink-2', className)}
      {...props}
    />
  )
}

export const ToastClose = ToastPrimitive.Close

export function ToastViewport({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        'fixed bottom-5 left-1/2 z-[60] flex w-[min(380px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function ToastBody({ children }: { children: ReactNode }) {
  return <div className="min-w-0 flex-1">{children}</div>
}
