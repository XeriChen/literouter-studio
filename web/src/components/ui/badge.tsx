import * as React from 'react'
import { cn } from '@/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-all duration-150',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow-xs',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-foreground/15 text-foreground bg-background/50',
        success: 'border-emerald-500/20 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        warning: 'border-amber-500/20 bg-amber-500/15 text-amber-600 dark:text-amber-400',
        openai: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono text-[11px]',
        anthropic: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-mono text-[11px]',
        purple: 'border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400 font-mono',
        cyan: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-mono',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }