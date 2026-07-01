import { useEffect, useRef, useState } from "react";

/**
 * Full-width "+" button that expands into an autocomplete input.
 * Suggestions come from previously entered dinners; typing a new name and
 * pressing Enter creates it.
 */
export default function AddMeal({
  suggestions,
  onAdd,
}: {
  suggestions: string[];
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  const matches = query
    ? suggestions.filter((s) => s.toLowerCase().includes(query)).slice(0, 8)
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

  function commit(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed);
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
      const pick = matches[highlight];
      // If the highlighted suggestion matches exactly, use it; otherwise
      // create whatever was typed.
      commit(pick && value.trim() === "" ? pick : value || pick || "");
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
              key={s}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
      {value.trim() &&
        !matches.some((m) => m.toLowerCase() === value.trim().toLowerCase()) && (
          <button className="combo-create" onMouseDown={(e) => {
            e.preventDefault();
            commit(value);
          }}>
            + Skapa “{value.trim()}”
          </button>
        )}
    </div>
  );
}
