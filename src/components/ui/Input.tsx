import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

interface Props extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 text-body text-ink',
        'placeholder:text-ink-subtle',
        'focus:outline-none focus:border-border-strong focus:ring-2 focus:ring-primary focus:ring-offset-0',
        'disabled:bg-surface-hover disabled:text-ink-muted disabled:cursor-not-allowed',
        'transition-colors',
        className,
      )}
      {...rest}
    />
  )
})
