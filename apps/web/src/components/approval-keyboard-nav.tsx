"use client";

/**
 * ApprovalKeyboardNav
 *
 * Wraps the approval queue list and adds keyboard shortcuts:
 *   j / ↓    — move to next item
 *   k / ↑    — move to previous item
 *   a         — approve selected item
 *   x         — reject selected item
 *   e         — focus reviewer note of selected item
 *   Escape    — blur / deselect
 *   ⌘⏎ / ⌃⏎  — submit the focused item's form
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface ApprovalKeyboardNavProps {
  itemCount: number;
  children: React.ReactNode;
}

export function ApprovalKeyboardNav({
  itemCount,
  children,
}: ApprovalKeyboardNavProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const getItem = useCallback(
    (idx: number) =>
      containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-approval-item]",
      )[idx] ?? null,
    [],
  );

  const scrollIntoView = useCallback(
    (idx: number) => {
      const el = getItem(idx);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [getItem],
  );

  const clickAction = useCallback(
    (idx: number, action: "approved" | "rejected") => {
      const item = getItem(idx);
      if (!item) return;
      const btn = item.querySelector<HTMLButtonElement>(
        `button[name="action"][value="${action}"]`,
      );
      btn?.click();
    },
    [getItem],
  );

  const focusNote = useCallback(
    (idx: number) => {
      const item = getItem(idx);
      if (!item) return;
      const input = item.querySelector<HTMLInputElement>(
        'input[name="reviewerNote"]',
      );
      input?.focus();
    },
    [getItem],
  );

  useEffect(() => {
    if (itemCount === 0) return;

    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Allow ⌘⏎ even in input to submit
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        if (selectedIndex !== null) {
          const item = getItem(selectedIndex);
          item?.querySelector<HTMLFormElement>("form")?.requestSubmit(
            item?.querySelector<HTMLButtonElement>('button[name="action"][value="approved"]') ?? undefined,
          );
        }
        return;
      }

      if (inInput) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => {
            const next = i === null ? 0 : Math.min(itemCount - 1, i + 1);
            scrollIntoView(next);
            getItem(next)?.focus();
            return next;
          });
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => {
            const prev = i === null ? 0 : Math.max(0, i - 1);
            scrollIntoView(prev);
            getItem(prev)?.focus();
            return prev;
          });
          break;
        case "a":
          if (selectedIndex !== null) {
            e.preventDefault();
            clickAction(selectedIndex, "approved");
          }
          break;
        case "x":
          if (selectedIndex !== null) {
            e.preventDefault();
            clickAction(selectedIndex, "rejected");
          }
          break;
        case "e":
          if (selectedIndex !== null) {
            e.preventDefault();
            focusNote(selectedIndex);
          }
          break;
        case "Escape":
          setSelectedIndex(null);
          (document.activeElement as HTMLElement)?.blur();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [itemCount, selectedIndex, getItem, scrollIntoView, clickAction, focusNote]);

  return (
    <div ref={containerRef} className="relative">
      {/* Keyboard shortcut legend */}
      {itemCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-gray-400">
          <span className="font-medium text-gray-500">Keyboard:</span>
          {[
            ["j/k", "navigate"],
            ["a", "approve"],
            ["x", "reject"],
            ["e", "edit note"],
            ["⌘⏎", "submit"],
          ].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-600">
                {key}
              </kbd>
              {label}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
