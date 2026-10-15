export type CalendarDateParts = {
  year: number;
  month?: number;
  day?: number;
};

export function isValidCalendarDateParts({ year, month, day }: CalendarDateParts): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (month === undefined) return day === undefined;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (day === undefined) return true;
  if (!Number.isInteger(day) || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
