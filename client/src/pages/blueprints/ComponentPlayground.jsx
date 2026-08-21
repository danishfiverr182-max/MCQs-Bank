import { useState } from 'react';
import SubjectRow from '@/components/blueprints/SubjectRow';
import DifficultySlider from '@/components/blueprints/DifficultySlider';
import SumValidator from '@/components/blueprints/SumValidator';

// Temporary harness so SubjectRow / DifficultySlider / SumValidator
// (Prompt 58) can be exercised with mock props before BlueprintBuilder.jsx
// (Prompt 59) exists to assemble them for real. Safe to delete once
// BlueprintBuilder.jsx ships — nothing else depends on this page.
const MOCK_EXISTING_SUBJECTS = ['Mathematics', 'Physics', 'Chemistry', 'English', 'Biology'];

export default function ComponentPlayground() {
  const totalQuestions = 100;

  const [subjects, setSubjects] = useState([
    { name: 'Mathematics', count: 40 },
    { name: 'Physics', count: 35 },
    { name: 'English', count: 20 },
  ]);

  const [distribution, setDistribution] = useState({ easy: 30, medium: 50, hard: 20 });

  const subjectSum = subjects.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
  const difficultySum = distribution.easy + distribution.medium + distribution.hard;

  const updateSubject = (index, updated) => {
    setSubjects((prev) => prev.map((s, i) => (i === index ? updated : s)));
  };

  const removeSubject = (index) => {
    setSubjects((prev) => prev.filter((_, i) => i !== index));
  };

  const addSubject = () => {
    setSubjects((prev) => [...prev, { name: '', count: 0 }]);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-6">
      <div>
        <h1 className="section-title">Blueprint Component Playground</h1>
        <p className="text-sm text-gray-500">
          Mock-props harness for SubjectRow, DifficultySlider, and SumValidator — standalone
          until BlueprintBuilder.jsx exists to host them.
        </p>
      </div>

      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Subjects</h2>
          <SumValidator label="Subjects" currentSum={subjectSum} expectedTotal={totalQuestions} />
        </div>

        <div className="space-y-2">
          {subjects.map((subject, index) => (
            <SubjectRow
              key={index}
              subject={subject}
              onChange={(updated) => updateSubject(index, updated)}
              onRemove={() => removeSubject(index)}
              disableRemove={subjects.length <= 1}
              existingSubjectNames={MOCK_EXISTING_SUBJECTS}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addSubject}
          className="text-sm text-primary-600 hover:underline"
        >
          + Add subject
        </button>
      </section>

      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Difficulty distribution</h2>
          <SumValidator
            label="Difficulty"
            currentSum={difficultySum}
            expectedTotal={totalQuestions}
          />
        </div>
        <DifficultySlider
          distribution={distribution}
          totalQuestions={totalQuestions}
          onChange={setDistribution}
        />
      </section>
    </div>
  );
}
