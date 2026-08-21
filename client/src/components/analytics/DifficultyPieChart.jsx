import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// DifficultyPieChart.jsx — Prompt 98.
// Colors match tailwind.config.js's easy/medium/hard tokens exactly —
// the same values DifficultyBadge.jsx (client/src/components/mcq) and
// QAChecklist.jsx already render difficulty with, so a difficulty reads
// the same color everywhere in the app, not just here.
const DIFFICULTY_COLORS = {
  easy: '#10B981',
  medium: '#F59E0B',
  hard: '#EF4444',
};

const DIFFICULTY_LABELS = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export default function DifficultyPieChart({ data }) {
  const total = (data || []).reduce((sum, d) => sum + (d.count || 0), 0);

  if (!data || data.length === 0 || total === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-400">
        No data available
      </div>
    );
  }

  const chartData = data.map((d) => ({
    ...d,
    label: DIFFICULTY_LABELS[d.difficulty] ?? d.difficulty,
    percent: total > 0 ? Math.round((d.count / total) * 100) : 0,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={chartData}
          dataKey="count"
          nameKey="label"
          cx="50%"
          cy="45%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {chartData.map((entry) => (
            <Cell key={entry.difficulty} fill={DIFFICULTY_COLORS[entry.difficulty] ?? '#94A3B8'} />
          ))}
        </Pie>
        <Tooltip formatter={(value, name, props) => [`${value} (${props.payload.percent}%)`, name]} />
        <Legend
          verticalAlign="bottom"
          height={36}
          formatter={(value, entry) => {
            const { payload } = entry;
            return `${value} — ${payload.count} (${payload.percent}%)`;
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
