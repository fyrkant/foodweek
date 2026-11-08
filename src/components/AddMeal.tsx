import { useEffect, useRef, useState } from "react";
import type { Dish, DishChoice } from "../api";

/**
 * Full-width "+" button that expands into an autocomplete input.
 * Suggestions come from previously entered dinners; typing a new name and
 * pressing Enter creates it.
 */
export default function AddMeal({
  suggestions,
  onAdd,
}: {
  suggestions: Dish[];
  onAdd: (dish: DishChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  const matches = query
    ? suggestions.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 8)
    : suggestions.slice(0, 8);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function close() {
    setOpen(false);
    setValue("");
    setHighlight(0);
  }

  function pick(dish: Dish) {
    onAdd({ dishId: dish.id });
    close();
  }

  /** Typed text: reuse the dish with that exact name (any case), else create it. */
  function commitText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const existing = suggestions.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    onAdd(existing ? { dishId: existing.id } : { name: trimmed });
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const highlighted = matches[highlight];
      // With nothing typed, Enter picks the highlighted suggestion; otherwise
      // it uses what was typed.
      if (highlighted && value.trim() === "") pick(highlighted);
      else if (value.trim()) commitText(value);
      else if (highlighted) pick(highlighted);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!open) {
    return (
      <button className="add-btn" onClick={() => setOpen(true)} aria-label="Lägg till middag">
        +
      </button>
    );
  }

  return (
    <div className="combo" ref={wrapRef}>
      <input
        ref={inputRef}
        value={value}
        placeholder="Vad blir det?"
        onChange={(e) => {
          setValue(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 && (
        <ul className="combo-list">
          {matches.map((s, i) => (
            <li
              key={s.id}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {value.trim() &&
        !matches.some((m) => m.name.toLowerCase() === value.trim().toLowerCase()) && (
          <button className="combo-create" onMouseDown={(e) => {
            e.preventDefault();
            commitText(value);
          }}>
            + Skapa “{value.trim()}”
          </button>
        )}
    </div>
  );
}
