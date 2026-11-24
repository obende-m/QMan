import type { ReactNode } from "react";
import { cn } from "./cn.js";

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Level 1 elevation is the default; `flat` drops the shadow for nested use. */
  flat?: boolean;
}

export function Card({ children, className, flat = false }: CardProps) {
  return (
    <section
      className={cn(
        // Glass by default; `flat` is a nested panel inside one, which must not
        // stack a second blur on the first.
        flat
          ? "rounded-lg border border-outline-variant/70 bg-surface-container-lowest/60"
          : "glass rounded-xl",
        className,
      )}
    >
      {children}
    </section>
  );
}

export interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: CardHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 px-gutter py-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-title-md font-semibold text-on-surface">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-body-sm text-on-surface-variant">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}
