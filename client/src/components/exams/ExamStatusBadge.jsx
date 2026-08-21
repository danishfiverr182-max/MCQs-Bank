// Small colored pill for an exam's active/inactive state.
//
// Originally lived inline in ExamList.jsx (Prompt 52) with a comment
// flagging it should be promoted here "if EditExam or ExamDetail end up
// needing the same visual later" — ExamDetail.jsx (Prompt 57) is that
// moment, so it now lives here and both pages import it.
export default function ExamStatusBadge({ status }) {
  const isActive = status === 'active';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isActive ? 'bg-success-light text-success-dark' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}
