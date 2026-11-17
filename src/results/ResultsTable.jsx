import { useState } from 'react';

import { columns, experimentColumns, sweepColumns, sortResultRows } from './tableColumns.js';

export default function ResultsTable({ rows, mode }) {
  const [sort, setSort] = useState({ column: null, direction: 'asc' });
  const [page, setPage] = useState(0);
  const visibleColumns = mode === 'sweep' ? sweepColumns : experimentColumns;
  const sorted = sort.column ? sortResultRows(rows, sort.column, sort.direction) : rows;
  const pageCount = Math.max(1, Math.ceil(sorted.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(currentPage * 10, currentPage * 10 + 10);
  const changeSort = (column) => {
    setSort((current) => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
    setPage(0);
  };
  return <section className="panel table-panel">
    <div className="table-head"><h3>Comparison results</h3><span>Times measured from the start of the run</span></div>
    <div className="table-scroll"><table>
      <thead><tr>{visibleColumns.map((key) => <th key={key} aria-sort={sort.column === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="sort-button" onClick={() => changeSort(key)}>{columns[key].label}{sort.column === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</button>
      </th>)}</tr></thead>
      <tbody>{pageRows.map((row) => <tr key={row.id}>{visibleColumns.map((key) => <td key={key}>{columns[key].render(row)}</td>)}</tr>)}</tbody>
    </table></div>
    {rows.length > 10 && <div className="table-pagination">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span>Page {currentPage + 1} of {pageCount}</span>
      <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div>}
  </section>;
}
