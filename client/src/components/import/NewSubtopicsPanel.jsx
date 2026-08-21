// "New Subtopics From This Import" — shows ONLY the Subtopic names
// import.service.js's runImportPipeline determined were newly created
// in TaxonomyNode by the import that produced the report currently on
// screen (see ImportReport.jsx / server's ensureTaxonomyForInsertedDocs
// for how that delta is computed). Never all of MongoDB's subtopics.
//
// Existing Subjects/Topics are deliberately out of scope here — per
// the feature spec, Subjects and Topics are already predefined and
// controlled through the MCQ Creation Prompt; only Subtopics are
// potentially unlimited and need this continuous-discovery loop.

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';

// Clean, prompt-ready format the admin pastes straight into their MCQ
// Creation Prompt — matches the spec's example exactly.
const buildCopyText = (subtopics) => `Subtopics:\n${subtopics.map((s) => `- ${s}`).join('\n')}`;

export default function NewSubtopicsPanel({ subtopics = [] }) {
  const [copied, setCopied] = useState(false);
  const count = subtopics.length;

  const handleCopy = async () => {
    const text = buildCopyText(subtopics);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Copied ${count} subtopic${count === 1 ? '' : 's'}`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to clipboard — your browser may be blocking clipboard access');
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">New Subtopics From This Import</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {count > 0
              ? `${count} new subtopic${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} added`
              : 'All imported MCQs matched existing Subtopics'}
          </p>
        </div>
        {count > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy Subtopics'}
          </Button>
        )}
      </div>

      {count > 0 ? (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-700 max-h-64 overflow-y-auto pr-1">
          {subtopics.map((subtopic) => (
            <li key={subtopic} className="truncate" title={subtopic}>
              • {subtopic}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-400">
          No New Subtopics — every imported MCQ used a Subtopic that already exists in the taxonomy.
        </p>
      )}
    </div>
  );
}
