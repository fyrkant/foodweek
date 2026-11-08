import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Meal } from "../api";

export default function MealCard({
  meal,
  onEdit,
  onDelete,
}: {
  meal: Meal;
  onEdit: (meal: Meal) => void;
  onDelete: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `meal-${meal.id}` });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="meal-card">
      <button
        className="drag-handle"
        aria-label="Dra för att flytta"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <button className="meal-name" onClick={() => onEdit(meal)} title="Visa och redigera">
        {meal.name}
        {meal.notes && <span className="meal-notes">{meal.notes}</span>}
      </button>
      {meal.recipe_url && (
        <a
          className="meal-recipe"
          href={meal.recipe_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Öppna recept"
          title="Öppna recept"
        >
          ↗
        </a>
      )}
      <button className="meal-delete" aria-label="Ta bort" onClick={() => onDelete(meal.id)}>
        ×
      </button>
    </div>
  );
}
