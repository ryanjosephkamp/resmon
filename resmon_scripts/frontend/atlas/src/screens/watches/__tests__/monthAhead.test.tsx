/**
 * The month ahead's marks: a fire's tip names its watch, its day and time,
 * and whether anything will run it, and the mark opens the watch; a day's
 * fires past the five it names are listed in the tip of its "more", and for
 * a screen reader, since that count opens nothing.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MonthAhead, fireTip, moreTip } from '../MonthAhead';
import type { CalendarEvent, RoutineRow } from '../model';
import type { SchedulerStatus } from '../firing';

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

const now = new Date(2026, 10, 4, 8, 0);
const at = (hour: number) => new Date(2026, 10, 5, hour, 0).toISOString();

function fire(id: number, routine: number, hour: number): CalendarEvent {
  return {
    id: `f${id}`, routine_id: routine, start: at(hour), end: at(hour), status: 'scheduled', type: 'routine', title: '',
    allDay: false, color: '', execution_id: null, new_results: null, query: null, total_results: null,
  };
}

const ROUTINES = [{ id: 4, name: 'Perovskite films', is_active: true }, { id: 5, name: 'Tandem cells', is_active: true }] as unknown as RoutineRow[];
const STATUS = { routines: [{ id: 4, will_fire: true }, { id: 5, will_fire: false }] } as unknown as SchedulerStatus;

test('a fire\'s tip: its day and time first, a doubt where something stands in the way, and the way to its watch', () => {
  expect(fireTip('Perovskite films', at(9), true)).toEqual({
    name: 'Perovskite films', value: 'Thursday, November 5 at 9:00\u00a0AM', notes: undefined, opens: 'Opens the watch',
  });
  expect(fireTip('Tandem cells', at(9), false).notes).toEqual(['Due, but nothing will run it.']);
  expect(moreTip([{ name: 'Tandem cells', start: at(21) }]).lines).toEqual([{ value: '9:00\u00a0PM', label: 'Tandem cells' }]);
});

test('a mark opens its watch and shows its tip; a day\'s other fires are in its count\'s tip and for a screen reader', () => {
  const events = [4, 5, 6, 7, 8, 9, 10].map((hour, i) => fire(i, i % 2 ? 5 : 4, hour));
  render(
    <MemoryRouter>
      <MonthAhead now={now} events={events} routines={ROUTINES} lit={null} status={STATUS} />
    </MemoryRouter>,
  );
  const grid = screen.getByRole('grid', { name: 'Fires by day' });
  const marks = within(grid).getAllByRole('link');
  expect(marks).toHaveLength(5);
  expect(marks[1]).toHaveAttribute('href', '/watches/5');
  fireEvent.pointerEnter(marks[1]!, { clientX: 400, clientY: 300 });
  const tip = screen.getByRole('tooltip');
  expect(tip.querySelector('.chart-tip-name')?.textContent).toBe('Tandem cells');
  expect(tip).toHaveTextContent('Due, but nothing will run it.');
  expect(tip.querySelector('.chart-tip-opens')?.textContent).toBe('Opens the watch');
  fireEvent.pointerLeave(marks[1]!);
  const more = within(grid).getByText(/^2 more/);
  expect(more).toHaveTextContent(/^2 more: Tandem cells at 9:00\sAM, Perovskite films at 10:00\sAM$/);
  fireEvent.pointerEnter(more, { clientX: 400, clientY: 340 });
  expect(screen.getByRole('tooltip')).toHaveTextContent('2 more fires this day');
  expect(screen.getByRole('tooltip').querySelector('.chart-tip-opens')).toBeNull();
});
