import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// MonthlyTrend.jsx — Prompt 98.
// data: [{ month: '2026-01', count: 12 }, ...] — testsPerExamPerMonth's
// totalsByMonth rollup, already zero-filled for every month in the
// window by the backend. That zero-filling is exactly why this
// component never shows an "empty state" the way the other two charts
// do: a flat line at zero on a brand-new install IS the real, correct
// picture ("nothing generated yet"), not missing data to apologize for.

const PRIMARY = '#4F46E5'; // tailwind.config.js primary.DEFAULT

// '2026-01' -> "Jan '26"
const formatMonthLabel = (monthKey) => {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  const label = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${label} '${String(year).slice(2)}`;
};

export default function MonthlyTrend({ data }) {
  const points = data || [];

  const chartData = points.map((d) => ({
    ...d,
    label: formatMonthLabel(d.month),
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" fontSize={12} />
        <YAxis allowDecimals={false} />
        <Tooltip
          formatter={(value) => [value, 'Tests generated']}
          labelFormatter={(label) => label}
        />
        <Line
          type="monotone"
          dataKey="count"
          name="Tests generated"
          stroke={PRIMARY}
          strokeWidth={2}
          dot={{ r: 3, fill: PRIMARY }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
