import type { ComponentPropsWithRef, CSSProperties, ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function classes(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  type = "button",
  disabled,
  className,
  children,
  "aria-busy": ariaBusy,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || ariaBusy}
      className={classes("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)}
    >
      {children}
      {loading && <span className="sr-only"> — in progress</span>}
    </button>
  );
}

export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={classes("ui-input", className)} />;
}

export function Select({ className, ...props }: ComponentPropsWithRef<"select">) {
  return <select {...props} className={classes("ui-input", className)} />;
}

export function Textarea({ className, ...props }: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={classes("ui-input", "ui-textarea", className)} />;
}

type FieldProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
};

export function Field({ id, label, hint, error, required, children }: FieldProps) {
  return (
    <div className="ui-field">
      <label htmlFor={id}>
        {label}{required && <span className="ui-field-required"> (required)</span>}
      </label>
      {children}
      {hint && <p className="ui-field-hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="ui-field-error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}

type BadgeProps = ComponentPropsWithRef<"span"> & { tone?: Tone; dot?: boolean };

export function Badge({ tone = "neutral", dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span {...props} className={classes("ui-badge", `ui-badge--${tone}`, className)}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Panel({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={classes("ui-panel", className)} />;
}

export function MetricMeter({ value, label }: { value: number | null; label: string }) {
  const known = value !== null && Number.isFinite(value);
  const safe = known ? Math.min(100, Math.max(0, value)) : undefined;
  const tone = safe !== undefined && safe > 90 ? "danger" : safe !== undefined && safe > 75 ? "warning" : "success";
  return (
    <div
      className={classes("ui-meter", !known && "ui-meter--unknown")}
      role={known ? "meter" : "img"}
      aria-label={known ? label : `${label}: no measurement available`}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={safe}
      aria-valuetext={safe === undefined ? undefined : `${safe}%`}
    >
      {safe === undefined
        ? <span className="ui-meter-unknown" aria-hidden="true">No measurement</span>
        : <span className={`ui-meter-fill ui-meter-fill--${tone}`} style={{ "--meter-value": `${safe}%` } as CSSProperties} />}
    </div>
  );
}

type NoticeProps = ComponentPropsWithRef<"div"> & { tone?: Exclude<Tone, "neutral"> };

export function Notice({ tone = "info", className, ...props }: NoticeProps) {
  return <div {...props} className={classes("ui-notice", `ui-notice--${tone}`, className)} />;
}
