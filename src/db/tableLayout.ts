/**
 * Table column layout.
 *
 * The table used to rely on `min-width` on `<th>`, which browsers ignore under
 * `table-layout: auto` — an 11-property database squeezed every column to
 * ~70px and the values ran into each other. Fixed layout solved the overlap but
 * made the table wider than the viewport, so content ran off the right edge
 * with the only scrollbar at the bottom of the table.
 *
 * So: measure the space, then choose widths that FIT it. Columns shrink toward
 * a floor before anything scrolls, and when there is room to spare they grow to
 * fill it, which is what makes a 3-column database look deliberate instead of
 * trailing into empty space.
 */

/** Preferred width per property type. */
export function columnWidthForType(type: string): number {
  switch (type) {
    case "title":
      return 240;
    case "text":
      return 220;
    case "relation":
    case "multi_select":
      return 200;
    case "url":
    case "email":
    case "phone":
      return 190;
    case "select":
    case "status":
      return 160;
    case "date":
    case "created_time":
    case "last_edited_time":
      return 160;
    case "checkbox":
    case "number":
    case "unique_id":
      return 110;
    case "formula":
    case "rollup":
      return 160;
    default:
      return 160;
  }
}

/**
 * The narrowest a column may get before it stops being usable.
 *
 * Set so a header keeps its name: at 96px "Project" and "Progress" both
 * ellipsise to "Pro…", which is worse than scrolling.
 */
export const MIN_COLUMN_WIDTH = 124;
/** Grip column + row-delete column. */
export const TABLE_CHROME_WIDTH = 68;

/**
 * Widths for `types` inside `available` pixels.
 *
 * - everything fits with room to spare → grow proportionally, so the table
 *   fills the width;
 * - it only fits by shrinking → shrink toward the floor, the widest columns
 *   giving up the most;
 * - even the floor does not fit → return the floor and let the wrapper scroll.
 *
 * `available <= 0` means the container has not been measured yet, so the
 * preferred widths are returned unchanged rather than collapsing to nothing.
 */
export function fitColumns(
  types: readonly string[],
  available: number,
  opts: { min?: number; chrome?: number } = {},
): number[] {
  const min = opts.min ?? MIN_COLUMN_WIDTH;
  const chrome = opts.chrome ?? TABLE_CHROME_WIDTH;

  const desired = types.map((t) => Math.max(min, columnWidthForType(t)));
  if (!desired.length) return [];
  if (available <= 0) return desired;

  const floors = desired.map((w) => Math.min(w, min));
  const space = available - chrome;
  if (space <= 0) return floors;

  const sumDesired = desired.reduce((a, b) => a + b, 0);
  const sumFloors = floors.reduce((a, b) => a + b, 0);

  // Room to spare: grow every column by the same factor.
  if (sumDesired <= space) {
    const k = space / sumDesired;
    return growToTotal(desired.map((w) => Math.floor(w * k)), Math.floor(space));
  }

  // Not even the floors fit: scroll.
  if (sumFloors >= space) return floors;

  // Shrink between the floor and the preference, widest columns contributing most.
  const excess = sumDesired - space;
  const slack = sumDesired - sumFloors;
  const f = slack > 0 ? Math.min(1, excess / slack) : 0;
  return shrinkToTotal(
    desired.map((w, i) => Math.round(w - (w - floors[i]!) * f)),
    space,
  );
}

/** Rounding leaves a column or two short of the target; hand the remainder out. */
function growToTotal(widths: number[], total: number): number[] {
  const out = [...widths];
  let drift = total - out.reduce((a, b) => a + b, 0);
  let i = 0;
  while (drift > 0) {
    out[i % out.length] = (out[i % out.length] ?? 0) + 1;
    drift -= 1;
    i += 1;
  }
  return out;
}

/** Same, for a shrink that rounded a pixel over the target. */
function shrinkToTotal(widths: number[], total: number): number[] {
  const out = [...widths];
  let drift = out.reduce((a, b) => a + b, 0) - total;
  let i = 0;
  while (drift > 0 && i < out.length * 4) {
    const at = i % out.length;
    if ((out[at] ?? 0) > MIN_COLUMN_WIDTH) {
      out[at] = (out[at] ?? 0) - 1;
      drift -= 1;
    }
    i += 1;
  }
  return out;
}

/** Total table width, including the grip and delete columns. */
export function tableWidth(widths: readonly number[], chrome = TABLE_CHROME_WIDTH): number {
  return widths.reduce((a, b) => a + b, 0) + chrome;
}

/** True when the table is wider than the space, i.e. it needs to scroll. */
export function tableScrolls(widths: readonly number[], available: number, chrome = TABLE_CHROME_WIDTH): boolean {
  return available > 0 && tableWidth(widths, chrome) > available;
}
