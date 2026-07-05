import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Pixel padding rendered above and below the viewport so quick scrolling has
// content ready before it appears instead of flashing an empty spacer.
const OVERSCAN_PX = 600;
// Vertical gap between adjacent bubbles. The flex `gap` on `.chat-messages` is
// overridden to 0 and this gap is baked into each bubble wrapper's padding so
// the measured height (used for spacer math) is exact — no hidden gap drift.
const ITEM_GAP = 18;

interface VirtualItem {
  key: string;
}

interface VirtualizedBubblesProps {
  items: VirtualItem[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Rough height for items that haven't been measured yet. Only needs to be
   * close enough that the scrollbar doesn't jump before measurement. */
  estimateHeight: (index: number) => number;
  renderItem: (index: number) => React.ReactNode;
  stickToBottomRef: React.MutableRefObject<boolean>;
  /** Which end to seed the window at on a list/switch (parent decides, since
   * stickToBottomRef lags one effect phase behind at session-switch time). */
  seedAtBottom?: boolean;
  bottomRef?: React.RefObject<HTMLDivElement>;
  trailing?: React.ReactNode;
  /** Fires with the key of the topmost visible item (null when empty). */
  onTopVisibleKey?: (key: string | null) => void;
  /** Parent assigns a scrollToKey function so external callers (nav rail) can
   * jump to an item that may currently be virtualized out. */
  scrollToKeyRef?: React.MutableRefObject<((key: string) => void) | null>;
}

interface WindowRange {
  start: number;
  end: number;
  firstVisible: number;
  topSpacer: number;
  bottomSpacer: number;
}

const EMPTY_RANGE: WindowRange = { start: 0, end: -1, firstVisible: -1, topSpacer: 0, bottomSpacer: 0 };

export function VirtualizedBubbles({
  items,
  scrollRef,
  estimateHeight,
  renderItem,
  stickToBottomRef,
  seedAtBottom,
  bottomRef,
  trailing,
  onTopVisibleKey,
  scrollToKeyRef,
}: VirtualizedBubblesProps): React.ReactElement {
  const innerRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const firstVisibleRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTopKeyRef = useRef<string | null>(null);
  const prevFirstKeyRef = useRef<string | null>(null);
  const count = items.length;

  const [range, setRange] = useState<WindowRange>(EMPTY_RANGE);

  const getHeight = useCallback(
    (i: number) => heightsRef.current.get(items[i].key) ?? estimateHeight(i),
    [items, estimateHeight],
  );

  // Single O(count) pass that finds the render window, the first actually-
  // visible item, and the spacer heights — all from the scroll container's
  // current scrollTop. Bubbles are merged runs so count stays small even for
  // long sessions; this is cheap per animation frame.
  const computeRange = useCallback((): WindowRange => {
    const sc = scrollRef.current;
    if (!sc || count === 0) return EMPTY_RANGE;
    const scrollTop = sc.scrollTop;
    const viewportH = sc.clientHeight;
    const topBound = scrollTop - OVERSCAN_PX;
    const bottomBound = scrollTop + viewportH + OVERSCAN_PX;
    let acc = 0;
    let start = 0;
    let end = -1;
    let firstVisible = -1;
    let topSpacer = 0;
    let bottomOfEnd = 0;
    let foundStart = false;
    for (let i = 0; i < count; i++) {
      const h = getHeight(i);
      const top = acc;
      const bottom = acc + h;
      if (!foundStart && bottom > topBound) {
        start = i;
        topSpacer = top;
        foundStart = true;
      }
      if (firstVisible === -1 && bottom > scrollTop) firstVisible = i;
      if (top < bottomBound) {
        end = i;
        bottomOfEnd = bottom;
      }
      acc = bottom;
    }
    if (!foundStart) {
      start = 0;
      topSpacer = 0;
    }
    if (end < start) end = Math.min(count - 1, start);
    const bottomSpacer = Math.max(0, acc - bottomOfEnd);
    return { start, end, firstVisible: firstVisible === -1 ? start : firstVisible, topSpacer, bottomSpacer };
  }, [count, getHeight, scrollRef]);

  const recompute = useCallback(() => {
    const next = computeRange();
    firstVisibleRef.current = next.firstVisible;
    setRange((prev) =>
      prev.start === next.start &&
      prev.end === next.end &&
      prev.topSpacer === next.topSpacer &&
      prev.bottomSpacer === next.bottomSpacer
        ? prev
        : next,
    );
    if (onTopVisibleKey) {
      const key = next.firstVisible >= 0 && next.firstVisible < count ? items[next.firstVisible].key : null;
      if (key !== lastTopKeyRef.current) {
        lastTopKeyRef.current = key;
        onTopVisibleKey(key);
      }
    }
  }, [computeRange, count, items, onTopVisibleKey]);

  // Keep a live ref to recompute so the scroll listener can bind once instead of
  // re-binding on every streaming token (recompute changes per token, which
  // would otherwise thrash add/removeEventListener ~60x/s and cancel pending rAFs).
  const recomputeRef = useRef(recompute);
  useEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);

  // Recompute on scroll (rAF-throttled so a fast fling doesn't do work per pixel).
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recomputeRef.current();
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollRef]);

  // Recompute when the list itself changes. A session switch (first key
  // changed) seeds a best-guess window for the correct end so the wrong end
  // doesn't flash before ChatView's scroll-restore effect settles; a rAF then
  // refines against the real scrollTop. Within a session (streaming, new
  // message) just recompute.
  useLayoutEffect(() => {
    const firstKey = count > 0 ? items[0].key : null;
    const switched = firstKey !== prevFirstKeyRef.current;
    prevFirstKeyRef.current = firstKey;
    if (switched) {
      if (count === 0) {
        setRange(EMPTY_RANGE);
        return;
      }
      const end = count - 1;
      if (seedAtBottom) {
        // Seed the bottom window AND its top spacer (estimated) so scrollHeight
        // is already ~correct — otherwise ChatView's scrollIntoView("bottom")
        // can't reach the real bottom and the rAF recompute would land on the
        // top window instead.
        const start = Math.max(0, end - 7);
        let topSpacer = 0;
        for (let i = 0; i < start; i++) topSpacer += getHeight(i);
        firstVisibleRef.current = end;
        setRange({ start, end, firstVisible: end, topSpacer, bottomSpacer: 0 });
      } else {
        const seedEnd = Math.min(end, 7);
        let bottomSpacer = 0;
        for (let i = seedEnd + 1; i < count; i++) bottomSpacer += getHeight(i);
        firstVisibleRef.current = 0;
        setRange({ start: 0, end: seedEnd, firstVisible: 0, topSpacer: 0, bottomSpacer });
      }
      requestAnimationFrame(() => recomputeRef.current());
      return;
    }
    recompute();
  }, [items, count, recompute, stickToBottomRef]);

  // Measure rendered items and keep their cached heights exact. If a height
  // changed for an item ABOVE the viewport, shift scrollTop by the delta so the
  // visible content stays anchored instead of jumping (the classic windowing
  // jitter). Runs before paint, so the user never sees the jump.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const sc = scrollRef.current;
    if (!inner || !sc) return;
    const nodes = inner.querySelectorAll<HTMLElement>("[data-vkey]");
    if (nodes.length === 0) return;
    const fv = firstVisibleRef.current;
    let deltaAbove = 0;
    nodes.forEach((el) => {
      const key = el.dataset.vkey as string;
      const idx = Number(el.dataset.idx);
      const h = el.offsetHeight;
      const prev = heightsRef.current.get(key);
      if (prev !== undefined && prev !== h && idx < fv) deltaAbove += h - prev;
      if (prev !== h) heightsRef.current.set(key, h);
    });
    if (stickToBottomRef.current) {
      // Anchor to bottom: when seeded/measured items turn out larger than the
      // estimate, scrollHeight grows — keep scrollTop pinned so a long idle
      // session doesn't park above the real bottom on first open.
      const maxTop = sc.scrollHeight - sc.clientHeight;
      if (sc.scrollTop < maxTop) sc.scrollTop = maxTop;
    } else if (deltaAbove !== 0) {
      sc.scrollTop += deltaAbove;
    }
  }, [range, items, scrollRef, stickToBottomRef]);

  // Jump to an item that may be virtualized out: widen the window to include
  // it, then scrollIntoView once it's mounted.
  const scrollToKey = useCallback(
    (key: string) => {
      const idx = items.findIndex((it) => it.key === key);
      if (idx < 0) return;
      const start = Math.max(0, idx - 2);
      const end = Math.min(count - 1, idx + 2);
      // Compute estimated spacers for the widened window so the target renders
      // at ~its real offset. Inheriting the previous topSpacer (often from the
      // opposite end of a long session) would place the bubble at a wildly wrong
      // position and scrollIntoView would race off, then recompute would snap
      // the window straight back — the jump effectively did nothing.
      let topSpacer = 0;
      for (let i = 0; i < start; i++) topSpacer += getHeight(i);
      let bottomSpacer = 0;
      for (let i = end + 1; i < count; i++) bottomSpacer += getHeight(i);
      setRange((prev) =>
        idx >= prev.start && idx <= prev.end ? prev : { start, end, firstVisible: idx, topSpacer, bottomSpacer },
      );
      requestAnimationFrame(() => {
        // Escape for a double-quoted attribute value (not CSS.escape, which
        // targets the identifier context and would corrupt chars like "." / ":").
        const sel = `[data-vkey="${key.replace(/["\\]/g, "\\$&")}"]`;
        const el = innerRef.current?.querySelector<HTMLElement>(sel);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    },
    [items, count, getHeight],
  );

  useEffect(() => {
    if (scrollToKeyRef) scrollToKeyRef.current = scrollToKey;
  }, [scrollToKeyRef, scrollToKey]);

  const rendered: React.ReactNode[] = [];
  for (let i = range.start; i <= range.end; i++) {
    const item = items[i];
    rendered.push(
      <div key={item.key} data-vkey={item.key} data-idx={i} style={{ paddingBottom: ITEM_GAP, flex: "0 0 auto" }}>
        {renderItem(i)}
      </div>,
    );
  }

  return (
    <div className="chat-messages" ref={innerRef} style={{ gap: 0 }}>
      {range.topSpacer > 0 && <div style={{ height: range.topSpacer, flex: "0 0 auto" }} aria-hidden="true" />}
      {rendered}
      {range.bottomSpacer > 0 && <div style={{ height: range.bottomSpacer, flex: "0 0 auto" }} aria-hidden="true" />}
      {trailing && <div style={{ paddingBottom: ITEM_GAP }}>{trailing}</div>}
      <div ref={bottomRef} />
    </div>
  );
}
