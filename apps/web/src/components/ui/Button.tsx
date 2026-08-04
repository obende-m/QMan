import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary shadow-sm hover:bg-on-primary-fixed-variant",
  secondary:
    "bg-surface-container-lowest text-on-surface border border-outline-variant hover:bg-surface-container-high",
  ghost: "text-on-surface-variant hover:bg-surface-container-high",
  danger:
    "bg-surface-container-lowest text-error border border-error/40 hover:bg-error-container",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-body-sm gap-1.5",
  md: "h-10 px-4 text-body-md gap-2",
  lg: "h-12 px-6 text-body-md gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded font-semibold",
        "transition-colors duration-150 active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * The large, low-density action buttons on the clinical workspace's "Now
 * Serving" card. Sized for speed: a doctor hits these repeatedly, often without
 * looking, so the target is generous and the label sits under the icon.
 */
export interface ActionButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
}

export function ActionButton({
  icon,
  label,
  tone = "default",
  className,
  type = "button",
  ...rest
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 rounded-md border p-4",
        "transition-colors duration-150 active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "danger"
          ? "border-error/30 bg-surface-container-low text-error hover:bg-error-container"
          : "border-outline-variant bg-surface-container-low text-on-surface hover:bg-surface-container-high",
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="text-body-sm font-semibold">{label}</span>
    </button>
  );
}
