import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Meal } from "../api";
import { WEEKDAYS_SV, parseDate, isToday, type DateStr } from "../dates";
import { holidayFor } from "../holidays";
import AddMeal from "./AddMeal";
import MealCard from "./MealCard";

export default function DayColumn({
  date,
  meals,
  today,
  suggestions,
  onAdd,
  onDelete,
}: {
  date: DateStr;
  meals: Meal[];
  today: DateStr;
  suggestions: string[];
  onAdd: (date: DateStr, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const d = parseDate(date);
  const weekday = WEEKDAYS_SV[(d.getUTCDay() + 6) % 7];
  const dayNum = d.getUTCDate();
  const holiday = holidayFor(date);

  const classes = ["day-col"];
  if (isToday(date, today)) classes.push("is-today");
  if (holiday?.red) classes.push("is-red");
  if (isOver) classes.push("is-over");

  return (
    <section ref={setNodeRef} className={classes.join(" ")}>
      <header className="day-head">
        <div className="day-title">
          <span className="day-weekday">{weekday}</span>
          <span className="day-date">{dayNum}</span>
        </div>
        {holiday && (
          <span className={`day-holiday ${holiday.red ? "red" : "eve"}`}>{holiday.name}</span>
        )}
      </header>

      <SortableContext
        items={meals.map((m) => `meal-${m.id}`)}
        strategy={verticalListSortingStrategy}
      >
        <div className="day-meals">
          {meals.map((m) => (
            <MealCard key={m.id} meal={m} onDelete={onDelete} />
          ))}
        </div>
      </SortableContext>

      <AddMeal suggestions={suggestions} onAdd={(name) => onAdd(date, name)} />
    </section>
  );
}
