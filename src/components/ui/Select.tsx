import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { className, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-2 text-body text-ink',
        'focus:outline-none focus:border-border-strong focus:ring-2 focus:ring-primary',
        'disabled:bg-surface-hover disabled:text-ink-muted disabled:cursor-not-allowed',
        'transition-colors',
        className,
      )}
      {...rest}
    />
  )
})
