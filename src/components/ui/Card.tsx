import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Сделать кликабельной (cursor + hover). */
  interactive?: boolean
}

/**
 * Compound Card компонент:
 *   <Card>
 *     <Card.Header>
 *       <Card.Title>...</Card.Title>
 *       <Card.Description>...</Card.Description>
 *     </Card.Header>
 *     <Card.Body>...</Card.Body>
 *     <Card.Footer>...</Card.Footer>
 *   </Card>
 *
 * Header/Body/Footer опциональны — карточка может быть простой обёрткой.
 */
export function Card({ className, interactive, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card bg-surface border border-border shadow-subtle',
        interactive && 'cursor-pointer transition-colors hover:bg-surface-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

Card.Header = function CardHeader({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-5 py-4',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

Card.Title = function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-heading text-ink', className)} {...rest}>
      {children}
    </h3>
  )
}

Card.Description = function CardDescription({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('mt-1 text-caption text-ink-muted', className)} {...rest}>
      {children}
    </p>
  )
}

interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  /** Уменьшить вертикальные отступы (для плотных списков). */
  dense?: boolean
}

Card.Body = function CardBody({ className, dense, children, ...rest }: CardBodyProps) {
  return (
    <div className={cn(dense ? 'p-3' : 'p-5', className)} {...rest}>
      {children}
    </div>
  )
}

Card.Footer = function CardFooter({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-5 py-3',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

interface CardHeaderActionProps {
  children: ReactNode
}

Card.HeaderAction = function CardHeaderAction({ children }: CardHeaderActionProps) {
  return <div className="shrink-0">{children}</div>
}
