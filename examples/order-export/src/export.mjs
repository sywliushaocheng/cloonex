// Example only: serialize identifiers from rows already loaded on one page.
export function exportOrderIds(currentPageRows) {
  return currentPageRows.map((row) => row.id).join(',');
}
