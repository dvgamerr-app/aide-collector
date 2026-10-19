/** `doUpdateSet` callback that overwrites every non-key column with the value from the rejected insert. */
export const updateFromExcluded =
  (columns, keys = []) =>
  (eb) =>
    Object.fromEntries(columns.filter((column) => !keys.includes(column)).map((column) => [column, eb.ref(`excluded.${column}`)]))
