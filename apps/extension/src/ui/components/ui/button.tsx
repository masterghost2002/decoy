import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,filter] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // A disabled primary button has to stop reading as the call to action,
        // and dimming a saturated amber is not enough on its own.
        primary:
          'bg-primary text-primary-foreground hover:brightness-110 disabled:bg-muted disabled:text-muted-foreground',
        secondary: 'border border-border-strong bg-card hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
      },
      size: {
        sm: 'h-7 px-2 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-sm [&_svg]:size-4',
        icon: 'size-7 [&_svg]:size-4',
        'icon-sm': 'size-6 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a button, keeping the styles. */
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type })}
      {...props}
    />
  );
}

export { buttonVariants };
