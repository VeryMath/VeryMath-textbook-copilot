// Shared by the composer and the local API; page numbers refer to PDF page order.
export function pageRangeError(range, totalPages) {
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 1 || range.end < 1) return '请输入大于 0 的整数页码。';
  if (range.start > range.end) return '起始页不能大于结束页。';
  if (Number.isSafeInteger(totalPages) && range.end > totalPages) return `这本教材共 ${totalPages} 页，请调整页码范围。`;
  return '';
}
