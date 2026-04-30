import type { SelectHTMLAttributes } from 'react'

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className = '', ...rest }: Props) {
  return (
    <select
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 ${className}`}
      {...rest}
    />
  )
}
