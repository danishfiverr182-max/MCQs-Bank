import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// recharts is already a declared dependency (package.json) but Prompt
// 69 is its first actual usage anywhere in the app — Phase 6 is the
// first phase to need a real chart rather than a hand-rolled bar like
// DifficultySlider.jsx's. No existing chart pattern to match, so this
// establishes one: plain ResponsiveContainer wrappers, no theming
// beyond the raw hex values below.
//
// recharts renders raw SVG fill/stroke attributes, which can't consume
// Tailwind utility classes — so the difficulty colors are restated here
// as literal hex values, kept equal to tailwind.config.js's easy/
// medium/hard tokens (#10B981 / #F59E0B / #EF4444) so this chart still
// reads as "the same palette" as DifficultySlider.jsx's stacked bar
// elsewhere in the app, just expressed the way recharts requires.
const DIFFICULTY_COLORS = { easy: '#10B981', medium: '#F59E0B', hard: '#EF4444' };
const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const SUBJECT_BAR_COLOR = '#4F46E5'; // primary-600

// Props:
// - questions: the full resolved question array from a generated
//   test's response (each entry carries `subject` and `difficulty`
//   regardless of whether the underlying MCQ is still available, so
//   an unavailable-but-flagged question is still counted here — the
//   stats should always match the visible total, even for a test with
//   deleted questions in it).
export default function TestStats({ questions }) {
  const subjectData = useMemo(() => {
    const counts = new Map();
    (questions || []).forEach((q) => {
      counts.set(q.subject, (counts.get(q.subject) || 0) + 1);
    });
    return Array.from(counts.entries()).map(([subject, count]) => ({ subject, count }));
  }, [questions]);

  const difficultyData = useMemo(() => {
    const counts = { easy: 0, medium: 0, hard: 0 };
    (questions || []).forEach((q) => {
      if (q.difficulty in counts) counts[q.difficulty] += 1;
    });
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([difficulty, count]) => ({ difficulty, count }));
  }, [questions]);

  const total = (questions || []).length;

  if (total === 0) {
    return <p className="text-sm text-gray-400">No questions to summarize.</p>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Subject distribution
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={subjectData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="subject"
                tick={{ fontSize: 11 }}
                interval={0}
                angle={-20}
                textAnchor="end"
                height={50}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill={SUBJECT_BAR_COLOR} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Difficulty distribution
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={difficultyData}
                dataKey="count"
                nameKey="difficulty"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
                label={({ difficulty, count }) => `${DIFFICULTY_LABELS[difficulty]}: ${count}`}
              >
                {difficultyData.map((entry) => (
                  <Cell key={entry.difficulty} fill={DIFFICULTY_COLORS[entry.difficulty]} />
                ))}
              </Pie>
              <Tooltip formatter={(value, _name, item) => [value, DIFFICULTY_LABELS[item.payload.difficulty]]} />
              <Legend formatter={(value) => DIFFICULTY_LABELS[value] ?? value} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
