/**
 * Barrel-export для всех UI-компонентов.
 *
 * Импортируй из '@/components/ui' (НЕ из конкретных файлов):
 *   import { Button, Card, Field, Input, StatusBadge, toast } from '@/components/ui'
 *
 * Правила добавления нового компонента:
 *   1. Создавай в src/components/ui/<Name>.tsx
 *   2. Используй tokens из tailwind.config.ts (canvas/surface/ink/...)
 *   3. Используй cn() из @/lib/cn для composition классов
 *   4. Документируй contract в JSDoc — variant/size/icon/etc.
 *   5. Добавь export сюда
 *   6. Обнови docs/ui-conventions.md если новая категория
 */

export { Button } from './Button'
export { Input } from './Input'
export { Select } from './Select'
export { Field, Label } from './Label'
export { Card } from './Card'
export { Badge } from './Badge'
export { StatusBadge } from './StatusBadge'
export { EmptyState } from './EmptyState'
export { PageHeader } from './PageHeader'
export { Modal } from './Modal'
export { DataTable, type Column } from './DataTable'
export { Toaster, toast } from './Toaster'
