import { useEffect, useRef, useState } from "react";

/**
 * Whether the element scrolls sideways right now (`scrollWidth >
 * clientWidth`). Measured on mount and again whenever the element or one of
 * its children changes size, so a scroll region can be a tab stop only while
 * a keyboard user actually needs to reach it.
 */
export function useScrollsHorizontally<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setScrolls(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return { ref, scrolls };
}
