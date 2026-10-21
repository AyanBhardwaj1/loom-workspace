import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Toaster as SonnerToaster } from 'sonner'
import { IconButton } from './primitives'
import { cn } from './primitives'

/* ----------------------------------------------------------------------------
 * Modal — Radix Dialog restyled: 480px, --bg-overlay, 10px radius, modal
 * shadow, scale 0.98→1 + fade over --t-enter. Focus trap, Esc, backdrop
 * close and initial-focus come from Radix.
 * ------------------------------------------------------------------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: number
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-scrim fixed inset-0 z-scrim bg-scrim" />
        <DialogPrimitive.Content
          className="modal-panel fixed left-1/2 top-1/2 z-modal max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border border-hairline bg-overlay p-5 shadow-modal focus:outline-none"
          style={{ maxWidth: width }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <DialogPrimitive.Title className="min-w-0 break-words text-h4 text-primary">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton label="Close">
                <X size={16} strokeWidth={1.5} />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ----------------------------------------------------------------------------
 * Tooltip
 * ------------------------------------------------------------------------- */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={350}>{children}</TooltipPrimitive.Provider>
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (content === null || content === undefined || content === '') return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-dropdown max-w-72 rounded border border-hairline bg-overlay px-2 py-1 text-small text-secondary shadow-dropdown"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/* ----------------------------------------------------------------------------
 * Popover — floating confirms (fork-from-event), reaction pickers
 * ------------------------------------------------------------------------- */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  children,
  className,
  side = 'bottom',
  align = 'center',
  onOpenAutoFocus,
}: {
  children: ReactNode
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  onOpenAutoFocus?: (e: Event) => void
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side={side}
        align={align}
        sideOffset={6}
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          'z-dropdown rounded-lg border border-hairline bg-overlay p-3 shadow-dropdown focus:outline-none',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/* ----------------------------------------------------------------------------
 * Toasts — sonner, fully reskinned: bottom-right, raised surface, hairline,
 * 8px radius, 13px text, max 3, 4s, hover pauses.
 * ------------------------------------------------------------------------- */
export function Toasts() {
  return (
    <SonnerToaster
      position="bottom-right"
      visibleToasts={3}
      duration={4000}
      gap={8}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'group pointer-events-auto flex w-[min(340px,calc(100vw-2rem))] items-center gap-2.5 rounded-lg border border-hairline bg-raised px-3.5 py-3 text-ui text-primary shadow-dropdown',
          title: 'text-ui text-primary',
          description: 'text-small text-secondary',
          icon: 'shrink-0 text-secondary',
          actionButton: 'ml-auto shrink-0 rounded border border-hairline px-2 py-0.5 text-small text-secondary hover:bg-overlay',
        },
      }}
    />
  )
}
