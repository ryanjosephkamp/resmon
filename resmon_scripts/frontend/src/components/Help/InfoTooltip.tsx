import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Small inline help marker. Hover (or focus) to reveal a concise
 * explanation of the adjacent control.
 *
 * The bubble is rendered through a portal into ``document.body`` and
 * positioned with ``position: fixed`` so it escapes every overflow /
 * stacking container — most importantly, it can never be clipped by
 * the left sidebar when the "?" icon sits near the edge of the main
 * content. The horizontal position is clamped to the viewport with an
 * 8px margin, and the bubble flips above/below the icon based on
 * available space.
 */
interface InfoTooltipProps {
  text: string;
  /** Optional aria-label when the surrounding control has no visible label. */
  ariaLabel?: string;
}

const VIEWPORT_MARGIN = 8;
const GAP = 8;
const MAX_BUBBLE_WIDTH = 320;

const InfoTooltip: React.FC<InfoTooltipProps> = ({ text, ariaLabel }) => {
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    placement: 'top' | 'bottom';
    arrowLeft: number;
  }>({ top: 0, left: 0, placement: 'top', arrowLeft: MAX_BUBBLE_WIDTH / 2 });

  const updatePosition = useCallback(() => {
    const icon = iconRef.current;
    const bubble = bubbleRef.current;
    if (!icon || !bubble) return;
    const iconRect = icon.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const iconCenterX = iconRect.left + iconRect.width / 2;
    const desiredLeft = iconCenterX - bubbleRect.width / 2;
    const clampedLeft = Math.max(
      VIEWPORT_MARGIN,
      Math.min(desiredLeft, vw - bubbleRect.width - VIEWPORT_MARGIN),
    );

    const spaceAbove = iconRect.top;
    const spaceBelow = vh - iconRect.bottom;
    const placement: 'top' | 'bottom' =
      spaceAbove >= bubbleRect.height + GAP || spaceAbove >= spaceBelow ? 'top' : 'bottom';

    const top =
      placement === 'top'
        ? iconRect.top - bubbleRect.height - GAP
        : iconRect.bottom + GAP;

    // Keep the arrow pointing at the icon even when the bubble has been
    // shifted away from the icon's centerline to fit inside the viewport.
    const arrowLeft = Math.max(
      10,
      Math.min(bubbleRect.width - 10, iconCenterX - clampedLeft),
    );

    setPos({ top, left: clampedLeft, placement, arrowLeft });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const handler = () => updatePosition();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [open, updatePosition]);

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  return (
    <span
      ref={iconRef}
      className="info-tooltip"
      role="tooltip"
      tabIndex={0}
      aria-label={ariaLabel || text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span className="info-tooltip-icon" aria-hidden="true">?</span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            className={`info-tooltip-bubble info-tooltip-bubble-${pos.placement}`}
            role="presentation"
            style={{
              top: pos.top,
              left: pos.left,
              maxWidth: MAX_BUBBLE_WIDTH,
              ['--info-tooltip-arrow-left' as any]: `${pos.arrowLeft}px`,
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
};

export default InfoTooltip;
