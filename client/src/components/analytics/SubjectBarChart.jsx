import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts';

// SubjectBarChart.jsx — Prompt 98.
// Two rendering modes sharing one component since they share the same
// x-axis (subject name) and the same "no data" / responsive-container
// scaffolding — folding the coverage grouped-bar in here rather than a
// separate file, per the prompt.
//
// mode: 'count'    -> data: [{ subject, count }]
// mode: 'coverage' -> data: [{ subject, required, available }]

const PRIMARY = '#4F46E5'; // tailwind.config.js primary.DEFAULT
const MUTED = '#94A3B8'; // slate-400 — "required" bar, deliberately neutral
const DANGER = '#EF4444'; // tailwind.config.js danger.DEFAULT
const WARNING = '#F59E0B'; // tailwind.config.js warning.DEFAULT

function EmptyState({ message }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-gray-400">
      {message}
    </div>
  );
}

// Long subject names get clipped/overlapped on a horizontal x-axis at
// normal orientation — angling them is the standard Recharts fix, with
// extra bottom margin so the angled labels don't get cut off.
const angledTick = { angle: -30, textAnchor: 'end', fontSize: 12 };

export default function SubjectBarChart({ data, mode = 'count' }) {
  if (!data || data.length === 0) {
    return (
      <div className="h-full">
        <EmptyState message="No data available" />
      </div>
    );
  }

  if (mode === 'coverage') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 48, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="subject" tick={angledTick} interval={0} height={60} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Legend verticalAlign="top" height={28} />
          <Bar dataKey="required" name="Required" fill={MUTED} radius={[3, 3, 0, 0]} />
          <Bar dataKey="available" name="Available" radius={[3, 3, 0, 0]}>
            {data.map((entry) => (
              // Under-stocked subjects (available < required) get flagged
              // red; available === required exactly gets an amber "just
              // enough" nudge; comfortably covered subjects stay primary.
              <Cell
                key={entry.subject}
                fill={
                  entry.available < entry.required
                    ? DANGER
                    : entry.available === entry.required
                      ? WARNING
                      : PRIMARY
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 48, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="subject" tick={angledTick} interval={0} height={60} />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" name="MCQs" fill={PRIMARY} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
