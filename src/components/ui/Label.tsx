import type { LabelHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface FieldProps {
  label?: string
  hint?: string
  error?: string
  required?: boolean
  htmlFor?: string
  className?: string
  children: ReactNode
}

/**
 * Composite поле с label + input + hint/error.
 *
 * <Field label="Email" hint="Используется для входа">
 *   <Input ... />
 * </Field>
 *
 * <Field label="Пароль" error={errors.password}>
 *   <Input type="password" ... />
 * </Field>
 */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-caption text-ink-muted">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <span className="text-caption text-danger">{error}</span>
      ) : hint ? (
        <span className="text-caption text-ink-subtle">{hint}</span>
      ) : null}
    </div>
  )
}

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

/** Просто стилизованный <label> когда нужен без обёртки Field. */
export function Label({ className, children, ...rest }: LabelProps) {
  return (
    <label className={cn('text-caption text-ink-muted', className)} {...rest}>
      {children}
    </label>
  )
}
