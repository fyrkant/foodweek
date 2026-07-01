import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { api, type Meal } from "../api";
import {
  addDays,
  formatSpan,
  isoWeekNumber,
  startOfWeek,
  toDateStr,
  weekDays,
  type DateStr,
} from "../dates";
import DayColumn from "./DayColumn";

type MealsByDay = Record<DateStr, Meal[]>;

function group(days: DateStr[], meals: Meal[]): MealsByDay {
  const out: MealsByDay = {};
  for (const d of days) out[d] = [];
  for (const m of meals) {
    if (out[m.date]) out[m.date].push(m);
  }
  for (const d of days) out[d].sort((a, b) => a.sort_order - b.sort_order);
  return out;
}

function flatten(days: DateStr[], byDay: MealsByDay): Meal[] {
  return days.flatMap((d) =>
    byDay[d].map((m, i) => ({ ...m, date: d, sort_order: i })),
  );
}

const mealId = (id: string) => Number(id.replace("meal-", ""));

export default function WeekView({ onLogout }: { onLogout: () => void }) {
  const today = useMemo(() => toDateStr(new Date()), []);
  const [monday, setMonday] = useState<Date>(() => startOfWeek(new Date()));
  const days = useMemo(() => weekDays(monday), [monday]);

  const [byDay, setByDay] = useState<MealsByDay>(() => group(days, []));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadWeek = useCallback(async () => {
    try {
      const { meals } = await api.getMeals(days[0], days[6]);
      setByDay(group(days, meals));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte ladda veckan");
    }
  }, [days]);

  useEffect(() => {
    loadWeek();
  }, [loadWeek]);

  useEffect(() => {
    api
      .getDinners()
      .then((r) => setSuggestions(r.dinners))
      .catch(() => {});
  }, []);

  const activeMeal = useMemo(() => {
    if (!activeId) return null;
    const id = mealId(activeId);
    for (const d of days) {
      const found = byDay[d]?.find((m) => m.id === id);
      if (found) return found;
    }
    return null;
  }, [activeId, byDay, days]);

  function findContainer(id: string): DateStr | undefined {
    if (id in byDay) return id; // a day column
    const mid = mealId(id);
    return days.find((d) => byDay[d].some((m) => m.id === mid));
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = findContainer(String(active.id));
    const to = findContainer(String(over.id));
    if (!from || !to || from === to) return;

    setByDay((prev) => {
      const fromItems = prev[from];
      const toItems = prev[to];
      const movingId = mealId(String(active.id));
      const moving = fromItems.find((m) => m.id === movingId);
      if (!moving) return prev;

      const overIsColumn = String(over.id) in prev;
      const overIndex = overIsColumn
        ? toItems.length
        : toItems.findIndex((m) => m.id === mealId(String(over.id)));

      const newTo = [...toItems];
      newTo.splice(overIndex < 0 ? toItems.length : overIndex, 0, { ...moving, date: to });

      return {
        ...prev,
        [from]: fromItems.filter((m) => m.id !== movingId),
        [to]: newTo,
      };
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over) return;

    const from = findContainer(String(active.id));
    const to = findContainer(String(over.id));
    if (!from || !to) return;

    let next = byDay;
    if (from === to) {
      const items = byDay[to];
      const oldIndex = items.findIndex((m) => m.id === mealId(String(active.id)));
      const newIndex = items.findIndex((m) => m.id === mealId(String(over.id)));
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        next = { ...byDay, [to]: arrayMove(items, oldIndex, newIndex) };
        setByDay(next);
      }
    }

    // Persist the full week ordering (cheap, only 7 days).
    const payload = flatten(days, next).map((m) => ({
      id: m.id,
      date: m.date,
      sort_order: m.sort_order,
    }));
    api.reorder(payload).catch((err) => {
      setError(err instanceof Error ? err.message : "Kunde inte spara ordningen");
      loadWeek();
    });
  }

  async function handleAdd(date: DateStr, name: string) {
    try {
      const { meal } = await api.addMeal(date, name);
      setByDay((prev) => ({ ...prev, [date]: [...prev[date], meal] }));
      setSuggestions((prev) =>
        prev.some((s) => s.toLowerCase() === name.toLowerCase()) ? prev : [name, ...prev],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte lägga till");
    }
  }

  async function handleDelete(id: number) {
    const prev = byDay;
    setByDay((cur) => {
      const copy: MealsByDay = {};
      for (const d of days) copy[d] = cur[d].filter((m) => m.id !== id);
      return copy;
    });
    try {
      await api.deleteMeal(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte ta bort");
      setByDay(prev);
    }
  }

  async function handleLogout() {
    await api.logout().catch(() => {});
    onLogout();
  }

  const weekNo = isoWeekNumber(monday);

  return (
    <div className="app">
      <header className="topbar">
        <div className="week-info">
          <h1>Vecka {weekNo}</h1>
          <span className="span">{formatSpan(monday)}</span>
        </div>
        <div className="week-nav">
          <button onClick={() => setMonday((m) => startOfWeek(addDays(m, -7)))} aria-label="Föregående vecka">
            ‹
          </button>
          <button className="today-btn" onClick={() => setMonday(startOfWeek(new Date()))}>
            Idag
          </button>
          <button onClick={() => setMonday((m) => startOfWeek(addDays(m, 7)))} aria-label="Nästa vecka">
            ›
          </button>
          <button className="logout-btn" onClick={handleLogout}>
            Logga ut
          </button>
        </div>
      </header>

      {error && (
        <div className="error banner" onClick={() => setError(null)}>
          {error} (klicka för att stänga)
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="week-grid">
          {days.map((d) => (
            <DayColumn
              key={d}
              date={d}
              meals={byDay[d] ?? []}
              today={today}
              suggestions={suggestions}
              onAdd={handleAdd}
              onDelete={handleDelete}
            />
          ))}
        </div>

        <DragOverlay>
          {activeMeal ? (
            <div className="meal-card dragging">
              <span className="drag-handle">⋮⋮</span>
              <span className="meal-name">{activeMeal.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
