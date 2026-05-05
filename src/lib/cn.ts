import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose Tailwind-классы. clsx сводит conditional объекты в строку,
 * twMerge разрешает конфликты (`px-2 px-4` → `px-4`).
 *
 * Используется в каждом UI-компоненте:
 *   className={cn('base', isActive && 'bg-primary', className)}
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
