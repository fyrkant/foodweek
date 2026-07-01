import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Meal } from "../api";

export default function MealCard({
  meal,
  onDelete,
}: {
  meal: Meal;
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
      <span className="meal-name">{meal.name}</span>
      <button className="meal-delete" aria-label="Ta bort" onClick={() => onDelete(meal.id)}>
        ×
      </button>
    </div>
  );
}
