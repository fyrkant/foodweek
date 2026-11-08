import { useEffect, useRef, useState } from "react";
import type { Dish, DishPatch } from "../api";

/**
 * Modal for editing a dish's details. Changes apply to the dish itself,
 * so they show up on every day it's planned.
 */
export default function DishSheet({
  dish,
  onSave,
  onClose,
}: {
  dish: Dish;
  onSave: (patch: DishPatch) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(dish.name);
  const [recipeUrl, setRecipeUrl] = useState(dish.recipe_url ?? "");
  const [notes, setNotes] = useState(dish.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const patch: DishPatch = {};
    if (name.trim() !== dish.name) patch.name = name.trim();
    if (recipeUrl.trim() !== (dish.recipe_url ?? "")) patch.recipe_url = recipeUrl.trim();
    if (notes.trim() !== (dish.notes ?? "")) patch.notes = notes.trim();
    if (Object.keys(patch).length === 0) return onClose();
    if (patch.name === "") return setError("Namnet kan inte vara tomt");

    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={submit} role="dialog" aria-modal="true" aria-label="Maträtt">
        <label>
          <span>Namn</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Receptlänk</span>
          <input
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={recipeUrl}
            onChange={(e) => setRecipeUrl(e.target.value)}
          />
        </label>
        {dish.recipe_url && dish.recipe_url === recipeUrl.trim() && (
          <a className="sheet-open" href={dish.recipe_url} target="_blank" rel="noopener noreferrer">
            Öppna recept ↗
          </a>
        )}
        <label>
          <span>Anteckningar</span>
          <textarea
            rows={4}
            placeholder="Portioner, ändringar, var receptet finns…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <p className="sheet-hint muted">Gäller alla dagar där {dish.name} är planerad.</p>
        {error && <p className="error">{error}</p>}
        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            Avbryt
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Sparar…" : "Spara"}
          </button>
        </div>
      </form>
    </div>
  );
}
