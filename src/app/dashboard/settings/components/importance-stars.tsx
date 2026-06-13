"use client";

import { Star } from "lucide-react";

interface ImportanceStarsProps {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}

export function ImportanceStars({ value, onChange, readonly }: ImportanceStarsProps) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 10 }, (_, i) => (
        <button
          key={i}
          type="button"
          disabled={readonly}
          onClick={() => onChange?.(i + 1)}
          className={`transition-colors ${readonly ? "cursor-default" : "cursor-pointer hover:scale-110"}`}
        >
          <Star
            className={`h-3.5 w-3.5 ${
              i < value
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/40 fill-transparent"
            }`}
          />
        </button>
      ))}
    </div>
  );
}
