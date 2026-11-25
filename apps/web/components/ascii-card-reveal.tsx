"use client";

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  AsciiReveal,
  AsciiSkeleton,
  type AsciiRevealHandle,
  type AsciiRevealProps,
  type AsciiSkeletonProps,
} from "ascii-reveal";

// The library uses one frame clock. Keep every skeleton variant on the same period.
const skeletonTiming = { "--ars-speed": "1.8s" } as React.CSSProperties;

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const canvasSupportCache = new WeakMap<Document, boolean>();

function emptySubscribe() {
  return () => {};
}

function useIsClient(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

function subscribeReducedMotion(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onStoreChange);
    return () => mql.removeEventListener("change", onStoreChange);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onStoreChange);
    return () => mql.removeListener(onStoreChange);
  }
  return () => {};
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);
}

export function supportsAsciiCanvas(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const cached = canvasSupportCache.get(document);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    if (typeof window.requestAnimationFrame === "function") {
      const canvas = document.createElement("canvas");
      const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
      supported = Boolean(
        ctx &&
          typeof ctx.measureText === "function" &&
          typeof ctx.fillText === "function" &&
          typeof ctx.clearRect === "function",
      );
    }
  } catch {
    supported = false;
  }

  canvasSupportCache.set(document, supported);
  return supported;
}

export function useCanAnimateAscii(): boolean {
  const isClient = useIsClient();
  const reducedMotion = usePrefersReducedMotion();
  return isClient && !reducedMotion && supportsAsciiCanvas();
}

export type AsciiCardRevealProps = AsciiRevealProps;

export const AsciiCardReveal = forwardRef<AsciiRevealHandle, AsciiCardRevealProps>(
  function AsciiCardReveal(
    {
      as = "div",
      preset = "decode",
      speed = 0.5,
      duration = "fast",
      origin,
      selector,
      revealOnMount = true,
      revealOnHydrate = false,
      loading,
      shimmer = false,
      mascot,
      lazy = false,
      fallback = true,
      onRevealComplete,
      className,
      children,
      ...domProps
    },
    forwardedRef,
  ) {
    const canAnimate = useCanAnimateAscii();
    const revealRef = useRef<AsciiRevealHandle | null>(null);
    const fallbackRef = useRef<HTMLElement | null>(null);
    const onRevealCompleteRef = useRef(onRevealComplete);
    onRevealCompleteRef.current = onRevealComplete;
    // Manage lazy + loading in one layout effect so AsciiReveal never runs an unguarded
    // loading-transition reveal or paints offscreen content before hide({ instant: true }).
    const manageLazyLifecycle = canAnimate && lazy && revealOnMount;

    useIsomorphicLayoutEffect(() => {
      if (!manageLazyLifecycle) return;
      const handle = revealRef.current;
      const el = handle?.element;
      if (!handle || !el) return;

      if (loading) {
        void handle.hide({ instant: true });
        return;
      }

      const rect = el.getBoundingClientRect();
      const inViewport = rect.top < window.innerHeight * 1.02 && rect.bottom > 0;
      if (typeof IntersectionObserver !== "function" || inViewport) {
        void handle.reveal().then(() => onRevealCompleteRef.current?.());
        return;
      }

      void handle.hide({ instant: true });
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          void handle.reveal().then(() => onRevealCompleteRef.current?.());
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.01 },
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, [manageLazyLifecycle, loading]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        reveal: (options) => (canAnimate ? revealRef.current?.reveal(options) ?? Promise.resolve() : Promise.resolve()),
        hide: (options) => (canAnimate ? revealRef.current?.hide(options) ?? Promise.resolve() : Promise.resolve()),
        get element() {
          return canAnimate ? revealRef.current?.element ?? null : fallbackRef.current;
        },
      }),
      [canAnimate],
    );

    const classes = className ? `overview-ascii-reveal ${className}` : "overview-ascii-reveal";

    if (!canAnimate) {
      return createElement(
        as,
        {
          ...domProps,
          ref: fallbackRef,
          className: classes,
          "aria-busy": loading ? true : domProps["aria-busy"],
        },
        children,
      );
    }

    return (
      <AsciiReveal
        ref={revealRef}
        as={as}
        preset={preset}
        speed={speed}
        duration={duration}
        origin={origin}
        selector={selector}
        revealOnMount={manageLazyLifecycle ? false : revealOnMount}
        revealOnHydrate={revealOnHydrate}
        loading={manageLazyLifecycle ? undefined : loading}
        shimmer={shimmer}
        mascot={mascot}
        lazy={manageLazyLifecycle ? false : lazy}
        fallback={fallback}
        onRevealComplete={onRevealComplete}
        className={classes}
        aria-busy={loading ? true : domProps["aria-busy"]}
        {...domProps}
      >
        {children}
      </AsciiReveal>
    );
  },
);

export type AsciiCardSkeletonProps = AsciiSkeletonProps;

export function AsciiCardSkeleton({
  variant = "scan",
  animate = true,
  style,
  ...rest
}: AsciiCardSkeletonProps) {
  const canAnimate = useCanAnimateAscii();
  return <AsciiSkeleton {...rest} variant={variant} style={{ ...style, ...skeletonTiming }} animate={animate && canAnimate} />;
}

export function AsciiLoading({
  label,
  as = "div",
  className,
  id,
  lines = 2,
  widths = ["88%", "62%"],
  seed,
  variant,
}: Pick<AsciiCardSkeletonProps, "lines" | "widths" | "seed" | "variant"> & {
  label: string;
  as?: "div" | "span";
  className?: string;
  id?: string;
}) {
  const Element = as;
  return (
    <Element id={id} className={className} role="status">
      <span className="sr-only" data-ascii="skip">{label}</span>
      <AsciiCardSkeleton as="span" lines={lines} widths={widths} seed={seed} variant={variant} />
    </Element>
  );
}

export type { AsciiRevealHandle };
