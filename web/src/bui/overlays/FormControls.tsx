import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@bui/lib/utils'

export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'flex size-4.5 shrink-0 items-center justify-center rounded-[5px] bg-inset shadow-hairline transition-[background-color,box-shadow] duration-150',
        'data-[state=checked]:bg-accent data-[state=checked]:text-white data-[state=checked]:shadow-none dark:data-[state=checked]:text-page',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check size={12} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export const RadioGroup = RadioGroupPrimitive.Root

export function RadioItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'flex size-4.5 shrink-0 items-center justify-center rounded-full bg-inset shadow-hairline transition-shadow duration-150',
        'data-[state=checked]:shadow-[0_0_0_1px_var(--accent)]',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-accent" />
    </RadioGroupPrimitive.Item>
  )
}

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'inline-flex h-8 items-center justify-between gap-2 rounded-full bg-surface px-3 text-[13px] font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-inset',
        '[&>span:first-child]:min-w-0 [&>span:first-child]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown size={14} className="text-ink-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        className={cn(
          'bui z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card bg-surface p-1 shadow-overlay',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'flex h-7.5 cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 text-[12.5px] font-medium text-ink outline-none',
        'data-[highlighted]:bg-hover',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check size={13} strokeWidth={2.5} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export function FormField({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <label className={cn('grid gap-1.5', className)} htmlFor={htmlFor}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </label>
  )
}

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 rounded-control bg-field px-3 text-[13px] text-ink shadow-inset-field outline-none transition-shadow duration-150',
        'focus-visible:shadow-[0_0_0_1px_var(--accent)]',
        className,
      )}
      {...props}
    />
  )
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'rounded-control bg-field px-3 py-2 text-[13px] leading-relaxed text-ink shadow-inset-field outline-none transition-shadow duration-150',
        'focus-visible:shadow-[0_0_0_1px_var(--accent)]',
        className,
      )}
      {...props}
    />
  )
}
