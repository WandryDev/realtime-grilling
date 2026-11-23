"use client";

// A link inside the details that opens another thing of the call.

import { type ReactNode, useCallback } from "react";
import type { Selection } from "./model";

export const Open = ({
  children,
  className = "",
  onSelect,
  target,
}: {
  children: ReactNode;
  className?: string;
  onSelect: (selection: Selection) => void;
  target: Selection;
}) => {
  const open = useCallback(() => onSelect(target), [onSelect, target]);
  return (
    <button
      className={`text-left hover:underline ${className}`}
      onClick={open}
      type="button"
    >
      {children}
    </button>
  );
};
