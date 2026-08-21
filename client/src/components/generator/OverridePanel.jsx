import { useEffect, useMemo, useState } from 'react';
import SubjectTopicPicker from './SubjectTopicPicker';
import TopicRequirementsPicker from './TopicRequirementsPicker';

// OverridePanel.jsx — Prompt 78.
//
// Assembles every Phase 7 override control (Prompt 71's
// generationOverridesSchema) into one collapsible section, and derives
// a single MINIMAL overrides object from them — only fields the admin
// actually touched, matching generator.service.js's acceptOverrides
// (Prompt 72) "partial override, rest falls back to blueprint" design.
// Leaving everything at default must produce `onChange({})`, not a
// fully-populated object of every control's current value.
//
// Props:
// - blueprint: the active blueprint — supplies defaults (total_questions,
//   quality threshold baseline, subject list for SubjectTopicPicker).
// - onChange(overrides): fired with the current full overrides object
//   any time something changes. The parent (GeneratorForm.jsx) owns the
//   real state; this component is a controlled-output form only.

const DEFAULT_QUALITY_THRESHOLD = 50;

const DIFFICULTY_OPTIONS = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'easy', label: 'Easy only' },
  { value: 'medium', label: 'Medium only' },
  { value: 'hard', label: 'Hard only' },
];

// Small on/off switch, self-contained — nothing in the existing
// component library (client/src/components/ui) has a toggle yet, so
// this is a minimal one rather than pulling in a new dependency for
// two checkboxes.
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-center justify-between gap-3 select-none cursor-pointer">
      <span>
        <span className="block text-sm font-medium text-gray-700">{label}</span>
        {description && <span className="block text-xs text-gray-400">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          checked ? 'bg-primary' : 'bg-gray-200'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  );
}

export default function OverridePanel({ blueprint, onChange }) {
  const [isOpen, setIsOpen] = useState(false);

  // Every control's current DISPLAY value. Question count and exclude-
  // recent-tests are kept as raw string drafts (so an empty field is
  // distinguishable from "0") — everything else is a plain typed value.
  const [questionCountDraft, setQuestionCountDraft] = useState('');
  const [difficulty, setDifficulty] = useState('mixed');
  // undefined here mirrors SubjectTopicPicker's own contract: "nothing
  // touched yet" = every blueprint subject implicitly selected, without
  // this component having to pre-seed the full name list itself.
  const [selectedSubjects, setSelectedSubjects] = useState(undefined);
  const [selectedTopics, setSelectedTopics] = useState({});
  const [qualityThreshold, setQualityThreshold] = useState(DEFAULT_QUALITY_THRESHOLD);
  const [excludeRecentDraft, setExcludeRecentDraft] = useState('');
  const [randomize, setRandomize] = useState(true);
  const [pastPaperPriority, setPastPaperPriority] = useState(false);
  const [selectedTopicRequirements, setSelectedTopicRequirements] = useState({});

  const blueprintTotal = blueprint?.total_questions;
  const blueprintSubjectNames = useMemo(
    () => (blueprint?.subjects || []).map((s) => s.name),
    [blueprint]
  );

  // ── Derive the minimal overrides object ────────────────────────────
  // Each field is included only when it genuinely diverges from its
  // default — an empty question-count field, "Mixed" difficulty, every
  // subject selected, quality threshold at 50, no recency exclusion,
  // randomize on, and past-paper-priority off ALL produce no entry.
  const overrides = useMemo(() => {
    const out = {};

    if (questionCountDraft !== '') {
      const parsed = Number(questionCountDraft);
      if (Number.isFinite(parsed) && parsed > 0 && parsed !== blueprintTotal) {
        out.question_count = parsed;
      }
    }

    if (difficulty !== 'mixed') {
      out.difficulty = difficulty;
    }

    if (selectedSubjects !== undefined) {
      const isFullSet =
        selectedSubjects.length === blueprintSubjectNames.length &&
        blueprintSubjectNames.every((name) => selectedSubjects.includes(name));
      if (!isFullSet) {
        out.subjects = selectedSubjects;
      }
    }

    // The backend's overrides schema (generation.validator.js) carries
    // `topics` as a single flat array applied uniformly across every
    // working subject (see acceptOverrides's own comment: "attach as a
    // per-subject constraint, shape-only" — the same array copied onto
    // every subject) — it isn't a per-subject map. SubjectTopicPicker's
    // per-subject selections are merged/deduped into that one flat
    // list here so the combined overrides object matches the backend's
    // expected shape exactly.
    const flatTopics = [...new Set(Object.values(selectedTopics).flat())];
    if (flatTopics.length > 0) {
      out.topics = flatTopics;
    }

    if (qualityThreshold !== DEFAULT_QUALITY_THRESHOLD) {
      out.quality_threshold = qualityThreshold;
    }

    if (excludeRecentDraft !== '') {
      const parsed = Number(excludeRecentDraft);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.exclude_recent_tests = parsed;
      }
    }

    if (randomize !== true) {
      out.randomize = randomize;
    }

    if (pastPaperPriority !== false) {
      out.past_paper_priority = pastPaperPriority;
    }

    // "Topics to Include" feature — only include if at least one topic
    // requirement is specified. An empty selectedTopicRequirements object
    // produces nothing in the overrides (default behavior unchanged).
    if (Object.keys(selectedTopicRequirements).length > 0) {
      out.topic_requirements = selectedTopicRequirements;
    }

    return out;
  }, [
    questionCountDraft,
    blueprintTotal,
    difficulty,
    selectedSubjects,
    blueprintSubjectNames,
    selectedTopics,
    qualityThreshold,
    excludeRecentDraft,
    randomize,
    pastPaperPriority,
    selectedTopicRequirements,
  ]);

  // Fires on every genuine change to the derived overrides object —
  // including the very first render, which correctly reports `{}`.
  useEffect(() => {
    onChange?.(overrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  const activeCount = Object.keys(overrides).length;

  return (
    <div className="rounded-lg border border-surface-border overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-3 px-5 py-3 bg-gray-50 border-b border-surface-border font-semibold text-gray-800 text-left"
      >
        <span className="flex items-center gap-2">
          Advanced Options
          {activeCount > 0 && (
            <span className="rounded-full bg-primary-light px-2 py-0.5 text-[11px] font-semibold text-primary-700">
              {activeCount} override{activeCount === 1 ? '' : 's'} active
            </span>
          )}
        </span>
        <span className="text-gray-400">{isOpen ? '▲' : '▾'}</span>
      </button>

      {isOpen && (
        <div className="px-5 py-4 space-y-6">
          {/* Question count */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Question count</span>
            <input
              type="number"
              min={1}
              value={questionCountDraft}
              onChange={(e) => setQuestionCountDraft(e.target.value)}
              placeholder={
                blueprintTotal != null ? String(blueprintTotal) : 'Use blueprint default'
              }
              className="w-32 rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="block text-xs text-gray-400">
              Leave empty to use the blueprint's own total
              {blueprintTotal != null ? ` (${blueprintTotal})` : ''}.
            </span>
          </label>

          {/* Difficulty */}
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-gray-700">Difficulty</span>
            <div role="radiogroup" aria-label="Difficulty" className="flex flex-wrap gap-2">
              {DIFFICULTY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={difficulty === opt.value}
                  onClick={() => setDifficulty(opt.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    difficulty === opt.value
                      ? 'border-primary bg-primary-light text-primary-700'
                      : 'border-surface-border text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Subjects + Topics */}
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-gray-700">Subjects &amp; Topics</span>
            <SubjectTopicPicker
              blueprintSubjects={blueprint?.subjects || []}
              selectedSubjects={selectedSubjects}
              selectedTopics={selectedTopics}
              onSubjectsChange={setSelectedSubjects}
              onTopicsChange={setSelectedTopics}
            />
          </div>

          {/* Topics to Include — guarantees per-topic MCQ counts */}
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-gray-700">Topics to Include (Guarantees)</span>
            <p className="text-xs text-gray-400">
              Optional: specify exact MCQ counts from specific topics per subject. Random questions fill the rest.
            </p>
            <TopicRequirementsPicker
              blueprintSubjects={blueprint?.subjects || []}
              selectedTopicRequirements={selectedTopicRequirements}
              onChange={setSelectedTopicRequirements}
            />
          </div>

          {/* Quality threshold */}
          <label className="block space-y-1.5">
            <span className="flex items-center justify-between gap-2 text-sm font-medium text-gray-700">
              <span>Quality threshold</span>
              <span className="font-mono text-primary-700">{qualityThreshold}</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={qualityThreshold}
              onChange={(e) => setQualityThreshold(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <span className="block text-xs text-gray-400">
              Minimum MCQ quality score to draw from (0–100). Defaults to{' '}
              {DEFAULT_QUALITY_THRESHOLD}.
            </span>
          </label>

          {/* Exclude recently used */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">
              Exclude questions used in the last N tests
            </span>
            <input
              type="number"
              min={1}
              value={excludeRecentDraft}
              onChange={(e) => setExcludeRecentDraft(e.target.value)}
              placeholder="0 (no exclusion)"
              className="w-32 rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          {/* Randomize order */}
          <Toggle
            checked={randomize}
            onChange={setRandomize}
            label="Randomize order"
            description="Shuffle the final question order rather than grouping by subject."
          />

          {/* Past paper priority */}
          <Toggle
            checked={pastPaperPriority}
            onChange={setPastPaperPriority}
            label="Past paper priority"
            description="Prefer questions sourced from past papers, where available."
          />
        </div>
      )}
    </div>
  );
}
