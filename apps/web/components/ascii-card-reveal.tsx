"use client";

import {
  createElement,
  forwardRef,
  useImperativeHandle,
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
      speed,
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
        revealOnMount={revealOnMount}
        revealOnHydrate={revealOnHydrate}
        loading={loading}
        shimmer={shimmer}
        mascot={mascot}
        lazy={lazy}
        fallback={fallback}
        onRevealComplete={onRevealComplete}
        className={classes}
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
  ...rest
}: AsciiCardSkeletonProps) {
  const canAnimate = useCanAnimateAscii();
  return <AsciiSkeleton {...rest} variant={variant} animate={animate && canAnimate} />;
}

export type { AsciiRevealHandle };
