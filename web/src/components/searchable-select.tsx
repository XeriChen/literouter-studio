import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SearchableSelectOption {
  value: string
  label: string
  /** 额外参与模糊匹配的关键词（如真实模型 ID、显示名） */
  keywords?: string[]
  disabled?: boolean
}

interface SearchableSelectProps {
  options: SearchableSelectOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}

/** 基于 Popover + Command 的可搜索下拉；选项按 value 与 keywords 模糊匹配。 */
export function SearchableSelect({ options, value, onValueChange, placeholder = '请选择', searchPlaceholder = '搜索…', emptyText = '没有匹配的选项', disabled, className, ariaLabel }: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-1 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
            className,
          )}
        >
          <span className="min-w-0 truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput autoFocus placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={option.keywords}
                  disabled={option.disabled}
                  onSelect={() => { onValueChange(option.value); setOpen(false) }}
                >
                  <Check className={cn('h-3.5 w-3.5 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
