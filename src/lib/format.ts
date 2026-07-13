export const clpFormatter = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0,
});

export const numberFormatter = new Intl.NumberFormat('es-CL');

export function formatClp(value: number): string {
  return clpFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatUnits(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatDate(value: unknown): string {
  if (!value) return 'Sin fecha';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
