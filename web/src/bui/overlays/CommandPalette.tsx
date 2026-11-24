import { Command } from 'cmdk'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@bui/lib/utils'

import { Dialog, DialogContent, DialogTitle } from './Dialog'

export function CommandPalette({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={title}
        className="top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 p-0"
        showClose={false}
      >
        <DialogTitle className="visually-hidden">{title}</DialogTitle>
        <Command className="bui" label={title}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof Command.Input>) {
  return (
    <Command.Input
      className={cn(
        'h-12 w-full border-b border-line bg-transparent px-4 text-[14px] text-ink outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function CommandList({
  className,
  ...props
}: ComponentProps<typeof Command.List>) {
  return (
    <Command.List
      className={cn('max-h-80 overflow-y-auto p-1.5', className)}
      {...props}
    />
  )
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof Command.Empty>) {
  return (
    <Command.Empty
      className={cn('px-3 py-6 text-center text-[13px] text-ink-3', className)}
      {...props}
    />
  )
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof Command.Group>) {
  return (
    <Command.Group
      className={cn(
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3',
        className,
      )}
      {...props}
    />
  )
}

export function CommandItem({
  className,
  ...props
}: ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      className={cn(
        'flex h-9 cursor-pointer items-center gap-2 rounded-control px-2.5 text-[13px] font-medium text-ink',
        'data-[selected=true]:bg-hover',
        className,
      )}
      {...props}
    />
  )
}
